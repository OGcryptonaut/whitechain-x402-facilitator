// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { formatUnits, type Address } from "viem";
import { redactUrl, type ApiKeyConfig, type FacilitatorConfig, type NetworkConfig } from "./config.js";
import { settlementContext, type SettlementContext } from "./chain/context.js";
import { NetworkSigner } from "./chain/signer.js";
import { Reasons, PolicyError, loggableErrorMessage, publicErrorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { ApiKeyRegistry } from "./policy/apiKeys.js";
import { AuthorizationRegistry, authorizationKey, claimedPayer } from "./policy/dedupe.js";
import { FileDenylist, type AddressScreener } from "./policy/denylist.js";
import { createFeePolicy, type FeeContext, type FeePolicy } from "./policy/fee.js";
import { GasBudget, type BudgetScope, type Reservation } from "./policy/gasBudget.js";
import { TokenBucketRateLimiter, type RateLimiter } from "./policy/ratelimit.js";
import type { ParsedFacilitatorRequest } from "./schema.js";

export const X402_VERSION = 2;
/** Advertised so resource servers may offer gasless EIP-2612 permits for Permit2 flows; @x402/evm handles it natively. */
const EIP2612_GAS_SPONSORING_KEY = "eip2612GasSponsoring";
const SETTLEMENT_PENDING = "settlement_pending";
const BALANCE_CACHE_MS = 15_000;

export interface RequestContext {
  ip: string;
  apiKey: ApiKeyConfig | undefined;
}

export interface Outcome<T> {
  status: number;
  body: T;
  retryAfterSeconds?: number;
}

interface NetworkRuntime {
  config: NetworkConfig;
  signer: NetworkSigner;
  schemes: Set<string>;
  permit2: { deployed: boolean; exactProxy: boolean; uptoProxy: boolean; probedAt: string | null };
  rpcOk: boolean;
  lastError: string | undefined;
  balanceCache: { at: number; wei: bigint } | undefined;
}

export interface FacilitatorServiceDeps {
  denylist?: AddressScreener;
  rateLimiters?: { ip: RateLimiter; payer: RateLimiter; payTo: RateLimiter; global?: RateLimiter };
  gasBudget?: GasBudget;
  feePolicy?: FeePolicy;
  now?: () => number;
}

type HealthReport = { status: "ok" | "degraded"; body: Record<string, unknown> };

/**
 * Wraps @x402/core's `x402Facilitator` (with the official @x402/evm scheme implementations) in
 * the operating policy a public gas sponsor needs: rate limits, sanctions screening, daily gas
 * budgets, replay/duplicate protection, API keys and a fee hook.
 */
export class FacilitatorService {
  readonly config: FacilitatorConfig;
  readonly metrics = new Metrics();
  readonly address: Address;
  readonly gasBudget: GasBudget;
  readonly denylist: AddressScreener;
  readonly apiKeys: ApiKeyRegistry;
  readonly feePolicy: FeePolicy;
  private readonly log: Logger;
  private readonly facilitator = new x402Facilitator();
  private readonly networks = new Map<string, NetworkRuntime>();
  private readonly limiters: { ip: RateLimiter; payer: RateLimiter; payTo: RateLimiter; global?: RateLimiter };
  private readonly dedupe = new AuthorizationRegistry();
  private readonly pendingCharged = new Map<string, { scopes: BudgetScope[]; chargedWei: bigint }>();
  private healthCache: { at: number; report: HealthReport } | undefined;
  private healthInFlight: Promise<HealthReport> | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(config: FacilitatorConfig, logger: Logger, deps: FacilitatorServiceDeps = {}) {
    this.config = config;
    this.log = logger.child({ component: "facilitator" });
    const account = privateKeyToAccount(config.privateKey);
    this.address = account.address;
    this.gasBudget = deps.gasBudget ?? new GasBudget({ now: deps.now });
    this.denylist =
      deps.denylist ??
      new FileDenylist(config.denylistFile, {
        reloadSeconds: config.denylistReloadSeconds,
        onReload: (count) => this.log.info({ file: config.denylistFile, count }, "denylist loaded"),
        onError: (error) => this.log.error({ file: config.denylistFile, err: loggableErrorMessage(error) }, "denylist reload failed"),
      });
    this.apiKeys = new ApiKeyRegistry(config.apiKeys);
    this.feePolicy = deps.feePolicy ?? createFeePolicy(config.fee);
    const windowMs = config.rateLimit.windowSeconds * 1000;
    this.limiters = deps.rateLimiters ?? {
      ip: new TokenBucketRateLimiter({ limit: config.rateLimit.ipPerWindow, windowMs, maxKeys: config.rateLimit.maxKeys }),
      payer: new TokenBucketRateLimiter({ limit: config.rateLimit.payerPerWindow, windowMs, maxKeys: config.rateLimit.maxKeys }),
      payTo: new TokenBucketRateLimiter({ limit: config.rateLimit.payToPerWindow, windowMs, maxKeys: config.rateLimit.maxKeys }),
      ...(config.rateLimit.globalPerWindow > 0
        ? { global: new TokenBucketRateLimiter({ limit: config.rateLimit.globalPerWindow, windowMs, maxKeys: 1 }) }
        : {}),
    };

    for (const network of config.networks) {
      const signer = new NetworkSigner(network, account, {
        maxSettleGas: config.maxSettleGas,
        confirmationTimeoutMs: config.confirmationTimeoutMs,
        logger: this.log,
      });
      this.networks.set(network.id, {
        config: network,
        signer,
        schemes: new Set(),
        permit2: { deployed: false, exactProxy: false, uptoProxy: false, probedAt: null },
        rpcOk: false,
        lastError: undefined,
        balanceCache: undefined,
      });
      // `exact` (EIP-3009 and, where the proxy exists, Permit2) on every configured network.
      this.facilitator.register(
        network.id,
        new ExactEvmScheme(signer.facilitatorSigner, { simulateInSettle: config.simulateInSettle }),
      );
      this.networks.get(network.id)!.schemes.add("exact");
    }
    this.facilitator.registerExtension({ key: EIP2612_GAS_SPONSORING_KEY });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Probes every network (chain id, Permit2 proxies). Never throws for an unreachable RPC. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.probeNetworks();
    if (this.config.proxyProbeMinutes > 0) {
      this.probeTimer = setInterval(() => void this.probeNetworks(), this.config.proxyProbeMinutes * 60_000);
      this.probeTimer.unref();
    }
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }

  private async probeNetworks(): Promise<void> {
    await Promise.all([...this.networks.values()].map((rt) => this.probeNetwork(rt)));
  }

  private async probeNetwork(rt: NetworkRuntime): Promise<void> {
    const { signer, config } = rt;
    try {
      const chain = await signer.chainIdMatches();
      if (!chain.ok) {
        rt.rpcOk = false;
        rt.lastError = `RPC ${redactUrl(config.rpcUrl)} serves chain ${chain.actual}, config says ${config.chainId}`;
        this.log.error({ network: config.id, actual: chain.actual }, "chain id mismatch; network disabled");
        return;
      }
      const [permit2, exactProxy, uptoProxy] = await Promise.all([
        signer.hasCode(PERMIT2_ADDRESS as Address),
        signer.hasCode(x402ExactPermit2ProxyAddress as Address),
        signer.hasCode(x402UptoPermit2ProxyAddress as Address),
      ]);
      rt.permit2 = { deployed: permit2, exactProxy, uptoProxy, probedAt: new Date().toISOString() };
      rt.rpcOk = true;
      rt.lastError = undefined;
      if (this.config.schemes.has("upto") && uptoProxy && permit2 && !rt.schemes.has("upto")) {
        this.facilitator.register(config.id, new UptoEvmScheme(signer.facilitatorSigner));
        rt.schemes.add("upto");
        this.log.info({ network: config.id }, "x402 Upto Permit2 proxy found; `upto` scheme enabled");
      }
      this.log.info(
        { network: config.id, rpc: redactUrl(config.rpcUrl), permit2, exactProxy, uptoProxy, signer: signer.address },
        "network ready",
      );
    } catch (error) {
      rt.rpcOk = false;
      rt.lastError = publicErrorMessage(error);
      this.log.warn({ network: config.id, rpc: redactUrl(config.rpcUrl), err: loggableErrorMessage(error) }, "network probe failed");
    }
  }

  // ---------------------------------------------------------------- public API

  supported(): SupportedResponse {
    this.metrics.inc("http.supported");
    return this.facilitator.getSupported() as SupportedResponse;
  }

  network(id: string): NetworkRuntime | undefined {
    return this.networks.get(id);
  }

  async verify(req: ParsedFacilitatorRequest, ctx: RequestContext): Promise<Outcome<VerifyResponse>> {
    this.metrics.inc("verify.total");
    const payer = claimedPayer(req.paymentPayload.payload);
    const { paymentRequirements: reqs } = req;
    try {
      const rt = this.admit(req, ctx, payer);
      const dupKey = authorizationKey(reqs.network, reqs.asset, req.paymentPayload.payload);
      if (dupKey) {
        const state = this.dedupe.lookup(dupKey);
        if (state) {
          this.metrics.inc("policy.duplicate");
          throw new PolicyError(
            Reasons.duplicateSettlement,
            state.kind === "in-flight"
              ? "this authorization is being settled right now"
              : `this authorization was already settled in ${state.transaction}`,
            409,
          );
        }
      }
      await this.assertGasAvailable(rt, reqs.payTo, ctx.apiKey);

      const sctx: SettlementContext = {};
      let result = await settlementContext.run(sctx, () => this.facilitator.verify(req.paymentPayload, reqs));
      result = sanitizeMessages(normalizeGasCapReason(result, sctx));
      if (result.isValid) {
        this.metrics.inc("verify.valid");
        this.consumeIdentityLimits(payer, reqs.payTo, ctx.apiKey);
      } else {
        this.metrics.inc("verify.invalid");
        this.metrics.reason("verify", result.invalidReason);
      }
      this.log.info(
        {
          op: "verify",
          network: reqs.network,
          scheme: reqs.scheme,
          asset: reqs.asset,
          amount: reqs.amount,
          payTo: reqs.payTo,
          payer: result.payer ?? payer,
          isValid: result.isValid,
          reason: result.invalidReason,
          apiKey: ctx.apiKey?.name,
        },
        "verify",
      );
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof PolicyError) {
        this.metrics.inc("verify.invalid");
        this.metrics.reason("verify", error.reason);
        this.log.info({ op: "verify", network: reqs.network, payTo: reqs.payTo, payer, reason: error.reason, status: error.status }, "verify refused");
        return {
          status: error.status,
          body: { isValid: false, invalidReason: error.reason, invalidMessage: error.message, payer },
          retryAfterSeconds: error.retryAfterSeconds,
        };
      }
      this.metrics.inc("verify.error");
      this.metrics.reason("verify", Reasons.unexpectedVerifyError);
      this.log.error({ op: "verify", network: reqs.network, err: loggableErrorMessage(error) }, "verify failed unexpectedly");
      return {
        status: 500,
        body: { isValid: false, invalidReason: Reasons.unexpectedVerifyError, invalidMessage: publicErrorMessage(error), payer },
      };
    }
  }

  async settle(req: ParsedFacilitatorRequest, ctx: RequestContext): Promise<Outcome<SettleResponse>> {
    this.metrics.inc("settle.total");
    const payer = claimedPayer(req.paymentPayload.payload);
    const { paymentRequirements: reqs } = req;
    const network = reqs.network;
    const failure = (reason: string, message: string, status: number, retryAfterSeconds?: number): Outcome<SettleResponse> => ({
      status,
      body: { success: false, errorReason: reason, errorMessage: message, transaction: "", network, payer },
      retryAfterSeconds,
    });

    let rt: NetworkRuntime;
    let dupKey: string | undefined;
    let reservation: Reservation | undefined;
    let scopes: BudgetScope[] = [];
    let estimateWei = 0n;
    let feeCtx: FeeContext | undefined;
    try {
      rt = this.admit(req, ctx, payer);

      feeCtx = {
        network,
        asset: reqs.asset,
        amount: BigInt(reqs.amount),
        payTo: reqs.payTo,
        payer,
        apiKeyName: ctx.apiKey?.name,
      };
      const quote = this.feePolicy.quote(feeCtx);
      if (!quote.sponsor) {
        this.metrics.reason("settle", Reasons.feePolicyRejected);
        throw new PolicyError(Reasons.feePolicyRejected, quote.message ?? "the facilitator does not sponsor this payment", 403);
      }

      dupKey = authorizationKey(network, reqs.asset, req.paymentPayload.payload);
      if (dupKey && !this.dedupe.begin(dupKey)) {
        const state = this.dedupe.lookup(dupKey);
        this.metrics.inc("policy.duplicate");
        dupKey = undefined; // not ours to release
        throw new PolicyError(
          Reasons.duplicateSettlement,
          state?.kind === "settled"
            ? `this authorization was already settled in ${state.transaction}`
            : "this authorization is being settled right now",
          409,
        );
      }

      estimateWei = await this.assertGasAvailable(rt, reqs.payTo, ctx.apiKey);
      scopes = this.budgetScopes(reqs.payTo, ctx.apiKey);
      const reserved = this.gasBudget.reserve(scopes, estimateWei);
      if (!reserved.ok || !reserved.reservation) {
        throw this.budgetError(rt, reserved.ok ? scopes[0]! : reserved.scope, reserved.ok ? 0n : reserved.remainingWei);
      }
      reservation = reserved.reservation;

      const sctx: SettlementContext = {};
      let result = await settlementContext.run(sctx, () => this.facilitator.settle(req.paymentPayload, reqs));
      result = sanitizeMessages(normalizeGasCapReason(result, sctx));
      await this.account(rt, result, reserved.reservation, scopes, estimateWei, dupKey, feeCtx, ctx);
      reservation = undefined;
      dupKey = undefined;

      if (result.success) {
        this.metrics.inc("settle.success");
        this.consumeIdentityLimits(payer, reqs.payTo, ctx.apiKey);
      } else if (result.errorReason === SETTLEMENT_PENDING) {
        this.metrics.inc("settle.pending");
        this.metrics.reason("settle", result.errorReason);
      } else {
        this.metrics.inc("settle.failed");
        this.metrics.reason("settle", result.errorReason);
      }
      this.log.info(
        {
          op: "settle",
          network,
          scheme: reqs.scheme,
          asset: reqs.asset,
          amount: result.amount ?? reqs.amount,
          payTo: reqs.payTo,
          payer: result.payer ?? payer,
          success: result.success,
          reason: result.errorReason,
          tx: result.transaction || undefined,
          explorer: result.transaction && rt.config.explorerUrl ? `${rt.config.explorerUrl}/tx/${result.transaction}` : undefined,
          apiKey: ctx.apiKey?.name,
        },
        "settle",
      );
      return { status: 200, body: result };
    } catch (error) {
      reservation?.release();
      if (dupKey) this.dedupe.end(dupKey);
      if (error instanceof PolicyError) {
        this.metrics.inc("settle.failed");
        this.metrics.reason("settle", error.reason);
        this.log.info({ op: "settle", network, payTo: reqs.payTo, payer, reason: error.reason, status: error.status }, "settle refused");
        return failure(error.reason, error.message, error.status, error.retryAfterSeconds);
      }
      this.metrics.inc("settle.error");
      this.metrics.reason("settle", Reasons.unexpectedSettleError);
      this.log.error({ op: "settle", network, err: loggableErrorMessage(error) }, "settle failed unexpectedly");
      return failure(Reasons.unexpectedSettleError, publicErrorMessage(error), 500);
    }
  }

  // ---------------------------------------------------------------- policy pipeline

  /** Shared admission checks: version, routing, API key scope, asset allowlist, rate limits, denylist. */
  private admit(req: ParsedFacilitatorRequest, ctx: RequestContext, payer: string | undefined): NetworkRuntime {
    const reqs = req.paymentRequirements;
    if (req.x402Version !== X402_VERSION || req.paymentPayload.x402Version !== X402_VERSION) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.invalidRequest, `only x402Version ${X402_VERSION} is supported`, 400);
    }
    const rt = this.networks.get(reqs.network);
    if (!rt) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(
        Reasons.unsupportedSchemeNetwork,
        `network ${reqs.network} is not supported; see GET /supported`,
        400,
      );
    }
    if (!rt.schemes.has(reqs.scheme)) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(
        Reasons.unsupportedSchemeNetwork,
        `scheme ${reqs.scheme} is not supported on ${reqs.network}; see GET /supported`,
        400,
      );
    }
    if (req.paymentPayload.accepted.network !== reqs.network || req.paymentPayload.accepted.scheme !== reqs.scheme) {
      this.metrics.inc("policy.invalid_request");
      throw new PolicyError(Reasons.invalidRequest, "paymentPayload.accepted does not match paymentRequirements", 400);
    }
    if (rt.config.assets && !rt.config.assets.has(reqs.asset.toLowerCase())) {
      this.metrics.inc("policy.unsupported");
      throw new PolicyError(Reasons.unsupportedAsset, `asset ${reqs.asset} is not accepted on ${reqs.network}`, 400);
    }
    if (ctx.apiKey?.payTo && !ctx.apiKey.payTo.has(reqs.payTo.toLowerCase())) {
      this.metrics.inc("policy.unauthorized");
      throw new PolicyError(Reasons.invalidApiKey, `API key ${ctx.apiKey.name} may not settle to ${reqs.payTo}`, 401);
    }

    // Per-caller limit (IP, or the API key when one is presented).
    const multiplier = ctx.apiKey?.rateLimitMultiplier ?? 1;
    const callerKey = ctx.apiKey ? `apikey:${ctx.apiKey.name}` : `ip:${ctx.ip}`;
    const caller = this.limiters.ip.consume(callerKey, 1, multiplier);
    if (!caller.allowed) throw this.rateLimitError(caller.retryAfterSeconds, "caller");
    // Facilitator-wide ceiling: every admitted verify/settle fans out into several RPC calls, so
    // many callers (or many spoofed source addresses) must not be able to exhaust the RPC quota.
    if (this.limiters.global) {
      const global = this.limiters.global.consume("global");
      if (!global.allowed) throw this.rateLimitError(global.retryAfterSeconds, "facilitator-wide");
    }
    // Payer / payTo buckets are only *consumed* for payments that verify, so forged payloads
    // cannot exhaust a victim's quota; here we just refuse when the bucket is already empty.
    if (payer) {
      const d = this.limiters.payer.peek(`payer:${payer.toLowerCase()}`, 1, multiplier);
      if (!d.allowed) throw this.rateLimitError(d.retryAfterSeconds, "payer");
    }
    const payToDecision = this.limiters.payTo.peek(`payto:${reqs.payTo.toLowerCase()}`, 1, multiplier);
    if (!payToDecision.allowed) throw this.rateLimitError(payToDecision.retryAfterSeconds, "payTo");

    if (payer && this.denylist.isDenied(payer)) {
      this.metrics.inc("policy.denylisted");
      throw new PolicyError(Reasons.addressDenylisted, "payer address is denylisted", 403);
    }
    if (this.denylist.isDenied(reqs.payTo)) {
      this.metrics.inc("policy.denylisted");
      throw new PolicyError(Reasons.addressDenylisted, "payTo address is denylisted", 403);
    }
    return rt;
  }

  private rateLimitError(retryAfterSeconds: number, what: string): PolicyError {
    this.metrics.inc("policy.rate_limited");
    return new PolicyError(
      Reasons.rateLimited,
      `${what} rate limit exceeded; retry in ${retryAfterSeconds}s or request an API key`,
      429,
      retryAfterSeconds,
    );
  }

  private consumeIdentityLimits(payer: string | undefined, payTo: string, apiKey: ApiKeyConfig | undefined): void {
    const multiplier = apiKey?.rateLimitMultiplier ?? 1;
    if (payer) this.limiters.payer.consume(`payer:${payer.toLowerCase()}`, 1, multiplier);
    this.limiters.payTo.consume(`payto:${payTo.toLowerCase()}`, 1, multiplier);
  }

  private budgetScopes(payTo: string, apiKey: ApiKeyConfig | undefined): BudgetScope[] {
    const scopes: BudgetScope[] = [{ key: "global", limitWei: this.config.gasBudget.globalDailyWei }];
    if (apiKey?.dailyGasBudgetWei !== undefined) {
      scopes.push({ key: `apikey:${apiKey.name}`, limitWei: apiKey.dailyGasBudgetWei });
    } else {
      scopes.push({ key: `payto:${payTo.toLowerCase()}`, limitWei: this.config.gasBudget.perPayToDailyWei });
    }
    return scopes;
  }

  private budgetError(rt: NetworkRuntime, scope: BudgetScope, remainingWei: bigint): PolicyError {
    this.metrics.inc("policy.gas_budget_exceeded");
    const who = scope.key === "global" ? "the facilitator's global" : `this ${scope.key.split(":")[0]}'s`;
    const reset = this.gasBudget.secondsUntilReset();
    return new PolicyError(
      Reasons.gasBudgetExceeded,
      `${who} daily gas budget is exhausted (remaining ${formatUnits(remainingWei, rt.config.nativeDecimals)} ${rt.config.nativeSymbol}); resets at 00:00 UTC in ${reset}s`,
      429,
      reset,
    );
  }

  /** Checks budgets and signer balance; returns the reservation estimate in wei. */
  private async assertGasAvailable(rt: NetworkRuntime, payTo: string, apiKey: ApiKeyConfig | undefined): Promise<bigint> {
    let estimateWei: bigint;
    try {
      estimateWei = await rt.signer.estimatedSettleCostWei(this.config.settleGasEstimate);
    } catch (error) {
      this.log.warn({ network: rt.config.id, err: loggableErrorMessage(error) }, "RPC unavailable");
      throw new PolicyError(Reasons.rpcUnavailable, `the RPC for ${rt.config.id} is unavailable: ${publicErrorMessage(error, 160)}`, 503, 15);
    }
    const check = this.gasBudget.check(this.budgetScopes(payTo, apiKey), estimateWei);
    if (!check.ok) throw this.budgetError(rt, check.scope, check.remainingWei);
    const balance = await this.cachedBalance(rt);
    if (balance < estimateWei) {
      this.log.error({ network: rt.config.id, balance: balance.toString(), need: estimateWei.toString() }, "facilitator wallet out of gas");
      throw new PolicyError(
        Reasons.facilitatorOutOfGas,
        `the facilitator wallet ${rt.signer.address} cannot pay for gas on ${rt.config.id} right now`,
        503,
        60,
      );
    }
    return estimateWei;
  }

  private async cachedBalance(rt: NetworkRuntime, force = false): Promise<bigint> {
    const now = Date.now();
    if (!force && rt.balanceCache && now - rt.balanceCache.at < BALANCE_CACHE_MS) return rt.balanceCache.wei;
    const wei = await rt.signer.balance();
    rt.balanceCache = { at: now, wei };
    return wei;
  }

  /** Converts a settle result into budget, dedupe, fee and metrics bookkeeping. */
  private async account(
    rt: NetworkRuntime,
    result: SettleResponse,
    reservation: Reservation,
    scopes: BudgetScope[],
    estimateWei: bigint,
    dupKey: string | undefined,
    feeCtx: FeeContext,
    ctx: RequestContext,
  ): Promise<void> {
    const tx = result.transaction || undefined;
    if (!tx) {
      // Nothing was broadcast: no gas spent, the authorization is still unused.
      reservation.release();
      if (dupKey) this.dedupe.end(dupKey);
      return;
    }
    rt.balanceCache = undefined;
    const previously = this.pendingCharged.get(tx);
    let cost = rt.signer.takeTxCost(tx);
    if (!cost && result.errorReason !== SETTLEMENT_PENDING) cost = await rt.signer.fetchTxCost(tx);

    if (cost) {
      this.metrics.inc("gas.tx");
      if (previously) {
        // A retry reconciled a pending tx we already charged at the estimate: apply the delta.
        this.pendingCharged.delete(tx);
        reservation.release();
        const delta = cost.costWei - previously.chargedWei;
        this.gasBudget.record(previously.scopes, delta);
        this.metrics.addGas(rt.config.id, delta > 0n ? delta : 0n);
      } else {
        reservation.settle(cost.costWei);
        this.metrics.addGas(rt.config.id, cost.costWei);
      }
    } else {
      // Broadcast but no receipt yet (settlement_pending): charge the estimate for now.
      reservation.settle(estimateWei);
      this.metrics.addGas(rt.config.id, estimateWei);
      if (!previously) {
        if (this.pendingCharged.size >= 10_000) {
          const oldest = this.pendingCharged.keys().next().value;
          if (oldest) this.pendingCharged.delete(oldest);
        }
        this.pendingCharged.set(tx, { scopes, chargedWei: estimateWei });
      }
    }

    if (result.success) {
      if (dupKey) this.dedupe.settled(dupKey, tx);
      this.metrics.addSettledAmount(rt.config.id, feeCtx.asset, BigInt(result.amount ?? feeCtx.amount));
      this.feePolicy.onSettled({ ...feeCtx, payer: result.payer ?? feeCtx.payer }, this.feePolicy.quote(feeCtx), tx);
    } else if (dupKey) {
      // Pending (retry will reconcile) or reverted (authorization unused): allow another attempt.
      this.dedupe.end(dupKey);
    }
    void ctx;
  }

  // ---------------------------------------------------------------- health & metrics

  /**
   * Status report. The RPC probe behind it is shared by concurrent callers and cached for
   * HEALTH_CACHE_SECONDS, so an unauthenticated monitor (or anyone) polling /health cannot turn
   * it into an RPC amplifier.
   */
  async health(): Promise<HealthReport> {
    const ttlMs = this.config.healthCacheSeconds * 1000;
    const now = Date.now();
    if (this.healthCache && ttlMs > 0 && now - this.healthCache.at < ttlMs) return withUptime(this.healthCache.report, this.metrics.startedAt);
    if (!this.healthInFlight) {
      this.healthInFlight = this.probeHealth()
        .then((report) => {
          this.healthCache = { at: Date.now(), report };
          return report;
        })
        .finally(() => {
          this.healthInFlight = undefined;
        });
    }
    return withUptime(await this.healthInFlight, this.metrics.startedAt);
  }

  private async probeHealth(): Promise<HealthReport> {
    let degraded = false;
    const networks = await Promise.all(
      [...this.networks.values()].map(async (rt) => {
        const base = {
          network: rt.config.id,
          name: rt.config.name,
          chainId: rt.config.chainId,
          explorer: rt.config.explorerUrl,
          nativeSymbol: rt.config.nativeSymbol,
          schemes: [...rt.schemes],
          permit2: rt.permit2,
          facilitator: rt.signer.address,
          gasBudget: {
            globalDaily: this.config.gasBudget.globalDailyWei?.toString() ?? "unlimited",
            globalSpentToday: this.gasBudget.spentToday("global").toString(),
            perPayToDaily: this.config.gasBudget.perPayToDailyWei?.toString() ?? "unlimited",
            resetsInSeconds: this.gasBudget.secondsUntilReset(),
          },
        };
        try {
          const [balance, blockNumber, maxFeePerGas] = await Promise.all([
            this.cachedBalance(rt, true),
            rt.signer.publicClient.getBlockNumber(),
            rt.signer.maxFeePerGas(),
          ]);
          const settleCost = maxFeePerGas * this.config.settleGasEstimate;
          const runway = settleCost > 0n ? Number(balance / settleCost) : Number.POSITIVE_INFINITY;
          const low = runway < this.config.lowRunwaySettles;
          if (low) degraded = true;
          rt.rpcOk = true;
          return {
            ...base,
            rpcOk: true,
            blockNumber: blockNumber.toString(),
            gasBalanceWei: balance.toString(),
            gasBalance: `${formatUnits(balance, rt.config.nativeDecimals)} ${rt.config.nativeSymbol}`,
            maxFeePerGasWei: maxFeePerGas.toString(),
            estimatedSettleCostWei: settleCost.toString(),
            settleRunway: Number.isFinite(runway) ? runway : null,
            lowBalance: low,
          };
        } catch (error) {
          degraded = true;
          rt.rpcOk = false;
          rt.lastError = publicErrorMessage(error);
          this.log.warn({ network: rt.config.id, err: loggableErrorMessage(error) }, "health probe failed");
          return { ...base, rpcOk: false, error: rt.lastError };
        }
      }),
    );
    return {
      status: degraded ? "degraded" : "ok",
      body: {
        status: degraded ? "degraded" : "ok",
        service: "whitechain-x402-facilitator",
        x402Version: X402_VERSION,
        uptimeSeconds: Math.floor((Date.now() - this.metrics.startedAt.getTime()) / 1000),
        facilitator: this.address,
        denylistSize: this.denylist.size(),
        networks,
      },
    };
  }

  metricsSnapshot(): Record<string, unknown> {
    return {
      ...this.metrics.snapshot(),
      budget: {
        day: this.gasBudget.currentDay(),
        globalSpentTodayWei: this.gasBudget.spentToday("global").toString(),
        globalDailyLimitWei: this.config.gasBudget.globalDailyWei?.toString() ?? "unlimited",
        perPayToDailyLimitWei: this.config.gasBudget.perPayToDailyWei?.toString() ?? "unlimited",
        totalSpentWei: this.gasBudget.totalSpent.toString(),
        resetsInSeconds: this.gasBudget.secondsUntilReset(),
      },
      fees: this.feePolicy.snapshot(),
      dedupe: { tracked: this.dedupe.size() },
      rateLimiters: {
        callers: this.limiters.ip.size(),
        payers: this.limiters.payer.size(),
        payTos: this.limiters.payTo.size(),
        globalPerWindow: this.config.rateLimit.globalPerWindow || "unlimited",
      },
    };
  }
}

function withUptime(report: HealthReport, startedAt: Date): HealthReport {
  return { status: report.status, body: { ...report.body, uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000) } };
}

/**
 * The SDK copies raw viem error text into `invalidMessage` / `errorMessage` (e.g. a failed
 * simulation's message, which names the RPC URL). Only the sanitized form leaves the process.
 */
function sanitizeMessages<T extends VerifyResponse | SettleResponse>(result: T): T {
  if ("invalidMessage" in result && typeof result.invalidMessage === "string") {
    return { ...result, invalidMessage: publicErrorMessage(result.invalidMessage) };
  }
  if ("errorMessage" in result && typeof result.errorMessage === "string") {
    return { ...result, errorMessage: publicErrorMessage(result.errorMessage) };
  }
  return result;
}

/**
 * The signer wrapper rejects over-cap settlements by throwing inside the SDK's simulation; the SDK
 * reports that as a generic simulation failure. Surface our reason code (and message) instead.
 */
function normalizeGasCapReason<T extends VerifyResponse | SettleResponse>(result: T, sctx: SettlementContext): T {
  const failed = "isValid" in result ? !result.isValid : !(result as SettleResponse).success;
  if (!failed || !sctx.gasCap) return result;
  if ("isValid" in result) {
    return { ...result, invalidReason: Reasons.settleGasCapExceeded, invalidMessage: sctx.gasCap.message };
  }
  return { ...result, errorReason: Reasons.settleGasCapExceeded, errorMessage: sctx.gasCap.message };
}

export type { PaymentPayload, PaymentRequirements };
