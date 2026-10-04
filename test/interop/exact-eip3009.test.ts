// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Interop suite: the facilitator under test, an OFFICIAL @x402/express (and @x402/hono) resource
 * server configured with @x402/core's HTTPFacilitatorClient, and the OFFICIAL @x402/fetch client
 * with ExactEvmScheme, all against a local anvil with an EIP-3009 test token.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { VerifyError, SettleError, type Network } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseEther, type Address } from "viem";
import { ANVIL_KEYS, startAnvil, type AnvilInstance } from "../helpers/anvil.js";
import { deployFixtures, type ChainFixture } from "../helpers/chain.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { startExpressMerchant, startHonoMerchant, type RunningMerchant } from "../helpers/merchant.js";
import { buildEip3009Payment, postJson, requirementsFor } from "../helpers/payments.js";
import { StaticDenylist } from "../../src/policy/denylist.js";

const PRICE = "10000"; // 0.01 TUSD (6 decimals)

let anvil: AnvilInstance;
let chain: ChainFixture;
let facilitator: RunningFacilitator;
let merchant: RunningMerchant;
let network: Network;
let payer: PrivateKeyAccount;
let payTo: Address;

/** Wraps fetch with the official x402 client and records the PAYMENT-SIGNATURE header it sends. */
function paymentClient(account: PrivateKeyAccount, captured: string[] = []) {
  const spyFetch: typeof fetch = async (input, init) => {
    // Duck-typed: @hono/node-server swaps the global Request class once a Hono server has started,
    // so `instanceof Request` is not reliable across the suite.
    const headers =
      typeof input === "object" && input !== null && "headers" in input ? (input as Request).headers : new Headers(init?.headers);
    const sig = headers.get("PAYMENT-SIGNATURE");
    if (sig) captured.push(sig);
    return fetch(input, init);
  };
  return wrapFetchWithPaymentFromConfig(spyFetch, {
    schemes: [{ network, client: new ExactEvmClientScheme(account) }],
    // The test token is not in the SDK's default asset list.
    spendControls: false,
  });
}

beforeAll(async () => {
  anvil = await startAnvil();
  chain = await deployFixtures(anvil, { permit2: false });
  network = `eip155:${anvil.chainId}`;
  payer = privateKeyToAccount(generatePrivateKey()); // holds tokens but NO gas
  payTo = privateKeyToAccount(generatePrivateKey()).address;
  await chain.mint(chain.token, payer.address, 1_000_000n); // 1 TUSD
  facilitator = await startFacilitator(anvil, ANVIL_KEYS[9]);
  merchant = await startExpressMerchant({
    facilitatorUrl: facilitator.url,
    network,
    payTo,
    asset: chain.token,
    assetName: chain.tokenName,
    assetVersion: chain.tokenVersion,
    amount: PRICE,
  });
});

afterAll(async () => {
  await merchant?.stop();
  await facilitator?.stop();
  await anvil?.stop();
});

describe("GET /supported", () => {
  it("advertises exact on the configured network with the signer address", async () => {
    const client = new HTTPFacilitatorClient({ url: facilitator.url });
    const supported = await client.getSupported();
    expect(supported.kinds).toEqual(expect.arrayContaining([{ x402Version: 2, scheme: "exact", network }]));
    expect(supported.kinds.find((k) => k.scheme === "upto")).toBeUndefined(); // no Upto proxy on this anvil
    expect(supported.signers["eip155:*"]).toEqual([facilitator.service.address]);
    expect(supported.extensions).toContain("eip2612GasSponsoring");
  });

  it("serves a landing page, health and metrics", async () => {
    const landing = await fetch(`${facilitator.url}/`);
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-type")).toContain("text/html");
    const health = (await (await fetch(`${facilitator.url}/health`)).json()) as {
      status: string;
      facilitator: string;
      networks: { network: string; gasBalanceWei: string; settleRunway: number | null; rpcOk: boolean }[];
    };
    expect(health.status).toBe("ok");
    expect(health.facilitator).toBe(facilitator.service.address);
    expect(health.networks[0]?.network).toBe(network);
    expect(health.networks[0]?.rpcOk).toBe(true);
    expect(BigInt(health.networks[0]!.gasBalanceWei)).toBeGreaterThan(0n);
    expect(health.networks[0]!.settleRunway).toBeGreaterThan(50);
    const metrics = (await (await fetch(`${facilitator.url}/metrics`)).json()) as { verify: { total: number }; gas: unknown };
    expect(metrics.verify.total).toBe(0);
  });
});

describe("official resource server + official client (exact / EIP-3009)", () => {
  it("returns 402 with requirements when unpaid", async () => {
    const res = await fetch(`${merchant.url}/paid`);
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("pays: 200 + PAYMENT-RESPONSE, tokens move payer -> merchant, facilitator pays the gas", async () => {
    const payerBefore = await chain.balanceOf(chain.token, payer.address);
    const merchantBefore = await chain.balanceOf(chain.token, payTo);
    const facilitatorGasBefore = await chain.nativeBalance(facilitator.service.address);
    expect(await chain.nativeBalance(payer.address)).toBe(0n); // payer has no gas at all

    const fetchWithPayment = paymentClient(payer);
    const res = await fetchWithPayment(`${merchant.url}/paid`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, served: "express" });

    const header = res.headers.get("PAYMENT-RESPONSE");
    expect(header).toBeTruthy();
    const settlement = decodePaymentResponseHeader(header!);
    expect(settlement.success).toBe(true);
    expect(settlement.network).toBe(network);
    expect(settlement.payer?.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    const receipt = await chain.publicClient.getTransactionReceipt({ hash: settlement.transaction as `0x${string}` });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(facilitator.service.address.toLowerCase());

    expect(await chain.balanceOf(chain.token, payer.address)).toBe(payerBefore - BigInt(PRICE));
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));
    const facilitatorGasAfter = await chain.nativeBalance(facilitator.service.address);
    expect(facilitatorGasAfter).toBeLessThan(facilitatorGasBefore);
    expect(facilitatorGasBefore - facilitatorGasAfter).toBe(receipt.gasUsed * receipt.effectiveGasPrice);
    expect(await chain.nativeBalance(payer.address)).toBe(0n);

    const metrics = (await (await fetch(`${facilitator.url}/metrics`)).json()) as {
      settle: { success: number };
      gas: { spentWei: Record<string, string>; txCount: number };
    };
    expect(metrics.settle.success).toBeGreaterThanOrEqual(1);
    expect(metrics.gas.txCount).toBeGreaterThanOrEqual(1);
    expect(BigInt(metrics.gas.spentWei[network] ?? "0")).toBeGreaterThan(0n);
  });

  it("also works with the official @x402/hono middleware", async () => {
    const hono = await startHonoMerchant({
      facilitatorUrl: facilitator.url,
      network,
      payTo,
      asset: chain.token,
      assetName: chain.tokenName,
      assetVersion: chain.tokenVersion,
      amount: PRICE,
    });
    try {
      const merchantBefore = await chain.balanceOf(chain.token, payTo);
      const res = await paymentClient(payer)(`${hono.url}/paid`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ served: "hono" });
      expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).success).toBe(true);
      expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));
    } finally {
      await hono.stop();
    }
  });

  it("refuses a replayed payment header and moves no funds", async () => {
    const captured: string[] = [];
    const first = await paymentClient(payer, captured)(`${merchant.url}/paid`);
    expect(first.status).toBe(200);
    expect(captured).toHaveLength(1);
    const payerAfterFirst = await chain.balanceOf(chain.token, payer.address);
    const merchantAfterFirst = await chain.balanceOf(chain.token, payTo);

    const replay = await fetch(`${merchant.url}/paid`, { headers: { "PAYMENT-SIGNATURE": captured[0]! } });
    expect(replay.status).toBe(402);
    // v2 puts the machine-readable reason in the PAYMENT-REQUIRED header.
    const required = JSON.parse(Buffer.from(replay.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8")) as { error?: string };
    expect(required.error).toContain("duplicate_settlement");
    expect(await chain.balanceOf(chain.token, payer.address)).toBe(payerAfterFirst);
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantAfterFirst);

    // A facilitator with no memory of the settlement still refuses it: the chain says the nonce is used.
    const fresh = await startFacilitator(anvil, ANVIL_KEYS[8]);
    try {
      const client = new HTTPFacilitatorClient({ url: fresh.url });
      const payload = JSON.parse(Buffer.from(captured[0]!, "base64").toString("utf8")) as Parameters<typeof client.verify>[0];
      const verify = await client.verify(payload, payload.accepted);
      expect(verify.isValid).toBe(false);
      expect(verify.invalidReason).toBe("invalid_exact_evm_nonce_already_used");
      const gasBefore = await chain.nativeBalance(fresh.service.address);
      const settle = await client.settle(payload, payload.accepted);
      expect(settle.success).toBe(false);
      expect(settle.errorReason).toBe("invalid_exact_evm_nonce_already_used");
      expect(settle.transaction).toBe("");
      expect(await chain.nativeBalance(fresh.service.address)).toBe(gasBefore); // nothing broadcast
    } finally {
      await fresh.stop();
    }
  });
});

describe("negative cases through the official HTTPFacilitatorClient", () => {
  const client = () => new HTTPFacilitatorClient({ url: facilitator.url });
  const reqs = () =>
    requirementsFor({ network, asset: chain.token, payTo, amount: PRICE, name: chain.tokenName, version: chain.tokenVersion });

  it("underpayment: authorization value below the required amount", async () => {
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements, { value: "9999" });
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
    const settle = await client().settle(payload, requirements);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
  });

  it("wrong network: not configured on this facilitator -> 400 unsupported_scheme_network", async () => {
    const requirements = requirementsFor({
      network: "eip155:999999",
      asset: chain.token,
      payTo,
      amount: PRICE,
      name: chain.tokenName,
      version: chain.tokenVersion,
    });
    const payload = await buildEip3009Payment(payer, requirements);
    const error = await client()
      .verify(payload, requirements)
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(VerifyError);
    expect((error as VerifyError).statusCode).toBe(400);
    expect((error as VerifyError).invalidReason).toBe("unsupported_scheme_network");
    const settleError = await client()
      .settle(payload, requirements)
      .then(() => undefined, (e: unknown) => e);
    expect(settleError).toBeInstanceOf(SettleError);
    expect((settleError as SettleError).statusCode).toBe(400);
    expect((settleError as SettleError).errorReason).toBe("unsupported_scheme_network");
  });

  it("wrong network: payload network differs from requirements -> network mismatch", async () => {
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements);
    payload.accepted = { ...requirements, network: "eip155:1874" };
    const raw = await postJson(`${facilitator.url}/verify`, { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
    expect(raw.status).toBe(400);
    expect(raw.body).toMatchObject({ isValid: false, invalidReason: "invalid_request" });
  });

  it("expired authorization", async () => {
    const requirements = reqs();
    const past = Math.floor(Date.now() / 1000) - 60;
    const payload = await buildEip3009Payment(payer, requirements, { validBefore: String(past) });
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });

  it("not-yet-valid authorization", async () => {
    const requirements = reqs();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const payload = await buildEip3009Payment(payer, requirements, { validAfter: String(future) });
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_after");
  });

  it("recipient mismatch: authorization signed to a different payTo", async () => {
    const requirements = reqs();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const payload = await buildEip3009Payment(payer, requirements, { to: other });
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_recipient_mismatch");
  });

  it("insufficient balance", async () => {
    const poor = privateKeyToAccount(generatePrivateKey());
    const requirements = reqs();
    const payload = await buildEip3009Payment(poor, requirements);
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_insufficient_balance");
  });

  it("unsupported token: plain ERC-20 without EIP-3009", async () => {
    await chain.mint(chain.plain, payer.address, parseEther("1"));
    const requirements = requirementsFor({
      network,
      asset: chain.plain,
      payTo,
      amount: "1000",
      name: "Plain Token",
      version: "1",
    });
    const payload = await buildEip3009Payment(payer, requirements);
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_eip3009_not_supported");
    const gasBefore = await chain.nativeBalance(facilitator.service.address);
    const settle = await client().settle(payload, requirements);
    expect(settle.success).toBe(false);
    expect(settle.transaction).toBe("");
    expect(await chain.nativeBalance(facilitator.service.address)).toBe(gasBefore);
  });

  it("asset that is not a contract", async () => {
    const requirements = requirementsFor({
      network,
      asset: privateKeyToAccount(generatePrivateKey()).address,
      payTo,
      amount: "1000",
      name: "Ghost",
      version: "1",
    });
    const payload = await buildEip3009Payment(payer, requirements);
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("asset_not_deployed_contract");
  });

  it("gas cap: a token whose transfer burns more gas than MAX_SETTLE_GAS is refused at verify and settle", async () => {
    await chain.mint(chain.guzzler, payer.address, 1_000_000n);
    const requirements = requirementsFor({
      network,
      asset: chain.guzzler,
      payTo,
      amount: PRICE,
      name: "Gas Guzzler",
      version: "1",
    });
    const payload = await buildEip3009Payment(payer, requirements);
    const verify = await client().verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("settle_gas_cap_exceeded");
    const gasBefore = await chain.nativeBalance(facilitator.service.address);
    const settle = await client().settle(payload, requirements);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("settle_gas_cap_exceeded");
    expect(settle.transaction).toBe("");
    expect(await chain.nativeBalance(facilitator.service.address)).toBe(gasBefore);
    expect(await chain.balanceOf(chain.guzzler, payTo)).toBe(0n);
  });

  it("malformed body -> 400 invalid_request in protocol shape", async () => {
    const raw = await postJson(`${facilitator.url}/verify`, { x402Version: 2, paymentPayload: {}, paymentRequirements: {} });
    expect(raw.status).toBe(400);
    expect(raw.body).toMatchObject({ isValid: false, invalidReason: "invalid_request" });
    const rawSettle = await postJson(`${facilitator.url}/settle`, { nope: true });
    expect(rawSettle.status).toBe(400);
    expect(rawSettle.body).toMatchObject({ success: false, errorReason: "invalid_request", transaction: "" });
    const notJson = await fetch(`${facilitator.url}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { invalidReason: string }).invalidReason).toBe("invalid_request");
  });

  it("x402 v1 payloads are rejected (this facilitator speaks v2)", async () => {
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements);
    const raw = await postJson(`${facilitator.url}/verify`, {
      x402Version: 1,
      paymentPayload: { ...payload, x402Version: 1 },
      paymentRequirements: requirements,
    });
    expect(raw.status).toBe(400);
    expect(raw.body).toMatchObject({ isValid: false, invalidReason: "invalid_request" });
  });
});

describe("operating policy", () => {
  const reqs = (asset: Address = chain.token) =>
    requirementsFor({ network, asset, payTo, amount: PRICE, name: chain.tokenName, version: chain.tokenVersion });

  it("denylisted payer and payTo are refused with 403 address_denylisted", async () => {
    const badPayer = privateKeyToAccount(generatePrivateKey());
    const badPayTo = privateKeyToAccount(generatePrivateKey()).address;
    const denied = await startFacilitator(anvil, ANVIL_KEYS[7], {}, { denylist: new StaticDenylist([badPayer.address, badPayTo]) });
    try {
      const client = new HTTPFacilitatorClient({ url: denied.url });
      const requirements = reqs();
      const payload = await buildEip3009Payment(badPayer, requirements);
      const error = (await client.verify(payload, requirements).then(() => undefined, (e: unknown) => e)) as VerifyError;
      expect(error).toBeInstanceOf(VerifyError);
      expect(error.statusCode).toBe(403);
      expect(error.invalidReason).toBe("address_denylisted");

      const toBad = { ...requirements, payTo: badPayTo };
      const payload2 = await buildEip3009Payment(payer, toBad);
      const settleError = (await client.settle(payload2, toBad).then(() => undefined, (e: unknown) => e)) as SettleError;
      expect(settleError).toBeInstanceOf(SettleError);
      expect(settleError.statusCode).toBe(403);
      expect(settleError.errorReason).toBe("address_denylisted");
      expect(settleError.transaction).toBe("");
    } finally {
      await denied.stop();
    }
  });

  it("per-IP rate limit -> 429 rate_limit_exceeded with Retry-After; an API key lifts it", async () => {
    const limited = await startFacilitator(anvil, ANVIL_KEYS[7], {
      RATE_LIMIT_IP_PER_WINDOW: "2",
      RATE_LIMIT_WINDOW_SECONDS: "60",
      API_KEYS: JSON.stringify([{ name: "merchant-a", key: "test-key-merchant-a-0123456789", rateLimitMultiplier: 10 }]),
    });
    try {
      const requirements = reqs();
      const payload = await buildEip3009Payment(payer, requirements);
      const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
      expect((await postJson(`${limited.url}/verify`, body)).status).toBe(200);
      expect((await postJson(`${limited.url}/verify`, body)).status).toBe(200);
      const third = await postJson(`${limited.url}/verify`, body);
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ isValid: false, invalidReason: "rate_limit_exceeded" });
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);

      // The official client surfaces it as a typed VerifyError.
      const error = (await new HTTPFacilitatorClient({ url: limited.url })
        .verify(payload, requirements)
        .then(() => undefined, (e: unknown) => e)) as VerifyError;
      expect(error).toBeInstanceOf(VerifyError);
      expect(error.statusCode).toBe(429);

      // Same IP, but with a merchant API key: its own (10x) bucket.
      const withKey = await postJson(`${limited.url}/verify`, body, { "X-API-Key": "test-key-merchant-a-0123456789" });
      expect(withKey.status).toBe(200);
      const wrongKey = await postJson(`${limited.url}/verify`, body, { "X-API-Key": "nope" });
      expect(wrongKey.status).toBe(401);
      expect(wrongKey.body).toMatchObject({ isValid: false, invalidReason: "invalid_api_key" });
    } finally {
      await limited.stop();
    }
  });

  it("daily gas budget exceeded -> 429 gas_budget_exceeded and nothing is broadcast", async () => {
    // 1 wei budget: every settlement estimate exceeds it.
    const broke = await startFacilitator(anvil, ANVIL_KEYS[7], { GAS_BUDGET_GLOBAL_DAILY: "0.000000000000000001" });
    try {
      const client = new HTTPFacilitatorClient({ url: broke.url });
      const requirements = reqs();
      const payload = await buildEip3009Payment(payer, requirements);
      const verifyError = (await client.verify(payload, requirements).then(() => undefined, (e: unknown) => e)) as VerifyError;
      expect(verifyError).toBeInstanceOf(VerifyError);
      expect(verifyError.statusCode).toBe(429);
      expect(verifyError.invalidReason).toBe("gas_budget_exceeded");
      const gasBefore = await chain.nativeBalance(broke.service.address);
      const settleError = (await client.settle(payload, requirements).then(() => undefined, (e: unknown) => e)) as SettleError;
      expect(settleError).toBeInstanceOf(SettleError);
      expect(settleError.statusCode).toBe(429);
      expect(settleError.errorReason).toBe("gas_budget_exceeded");
      expect(settleError.errorMessage).toContain("resets at 00:00 UTC");
      expect(await chain.nativeBalance(broke.service.address)).toBe(gasBefore);
      const raw = await postJson(`${broke.url}/settle`, { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
      expect(Number(raw.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await broke.stop();
    }
  });

  it("per-payTo daily gas budget is enforced after real spend", async () => {
    // Budget just above one settlement's cost: the second settle to the same payTo is refused,
    // a different payTo still works (global budget is unlimited here).
    const payToA = privateKeyToAccount(generatePrivateKey()).address;
    const payToB = privateKeyToAccount(generatePrivateKey()).address;
    const perPayTo = await startFacilitator(anvil, ANVIL_KEYS[7], {
      GAS_BUDGET_GLOBAL_DAILY: "unlimited",
      GAS_BUDGET_PER_PAYTO_DAILY: "0.0005", // anvil: ~70k gas * ~2 gwei ≈ 0.00014 ETH per settle, estimate 120k*fee
      SETTLE_GAS_ESTIMATE: "100000",
    });
    try {
      const client = new HTTPFacilitatorClient({ url: perPayTo.url });
      const reqA = { ...reqs(), payTo: payToA };
      const first = await client.settle(await buildEip3009Payment(payer, reqA), reqA);
      expect(first.success).toBe(true);
      const second = await client.settle(await buildEip3009Payment(payer, reqA), reqA);
      expect(second.success).toBe(true);
      // Two settles spent ~0.0003; estimate for a third (~0.0002+) pushes past 0.0005.
      let refused: SettleError | undefined;
      for (let i = 0; i < 4 && !refused; i++) {
        const outcome = await client.settle(await buildEip3009Payment(payer, reqA), reqA).then(() => undefined, (e: unknown) => e);
        if (outcome instanceof SettleError) refused = outcome;
      }
      expect(refused).toBeInstanceOf(SettleError);
      expect(refused!.errorReason).toBe("gas_budget_exceeded");
      expect(refused!.errorMessage).toContain("payto");
      const reqB = { ...reqs(), payTo: payToB };
      const other = await client.settle(await buildEip3009Payment(payer, reqB), reqB);
      expect(other.success).toBe(true);
    } finally {
      await perPayTo.stop();
    }
  });

  it("asset allowlist: tokens outside the network's list are refused with 400 unsupported_asset", async () => {
    const strict = await startFacilitator(anvil, ANVIL_KEYS[7], {}, {}, { networkExtra: { assets: [chain.token] } });
    try {
      const client = new HTTPFacilitatorClient({ url: strict.url });
      const requirements = reqs(chain.guzzler);
      const payload = await buildEip3009Payment(payer, requirements);
      const error = (await client.verify(payload, requirements).then(() => undefined, (e: unknown) => e)) as VerifyError;
      expect(error).toBeInstanceOf(VerifyError);
      expect(error.statusCode).toBe(400);
      expect(error.invalidReason).toBe("unsupported_asset");
      const ok = await client.verify(await buildEip3009Payment(payer, reqs()), reqs());
      expect(ok.isValid).toBe(true);
    } finally {
      await strict.stop();
    }
  });

  it("REQUIRE_API_KEY=true refuses anonymous callers with 401", async () => {
    const gated = await startFacilitator(anvil, ANVIL_KEYS[7], {
      REQUIRE_API_KEY: "true",
      API_KEYS: JSON.stringify([{ name: "m", keySha256: "9f1a0c8b5c2c4e8d9c1a7b7e2d1c4b8a9e0f1a2b3c4d5e6f708192a3b4c5d6e7" }]),
    });
    try {
      const requirements = reqs();
      const payload = await buildEip3009Payment(payer, requirements);
      const raw = await postJson(`${gated.url}/settle`, { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
      expect(raw.status).toBe(401);
      expect(raw.body).toMatchObject({ success: false, errorReason: "invalid_api_key", network });
      expect(raw.headers.get("www-authenticate")).toContain("X-API-Key");
    } finally {
      await gated.stop();
    }
  });

  it("concurrent duplicate settles: exactly one succeeds, the other is refused as duplicate_settlement", async () => {
    const client = new HTTPFacilitatorClient({ url: facilitator.url });
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements);
    const merchantBefore = await chain.balanceOf(chain.token, payTo);
    const outcomes = await Promise.all(
      [0, 1, 2].map(() => client.settle(payload, requirements).then((r) => ({ r }), (e: unknown) => ({ e }))),
    );
    const successes = outcomes.filter((o) => "r" in o && o.r.success);
    const duplicates = outcomes.filter(
      (o): o is { e: SettleError } => "e" in o && o.e instanceof SettleError && o.e.errorReason === "duplicate_settlement",
    );
    expect(successes).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]!.e.statusCode).toBe(409);
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));

    // And afterwards verify/settle of the same authorization are refused without touching the chain.
    const again = (await client.verify(payload, requirements).then(() => undefined, (e: unknown) => e)) as VerifyError;
    expect(again).toBeInstanceOf(VerifyError);
    expect(again.invalidReason).toBe("duplicate_settlement");
    expect(again.invalidMessage).toContain(successes[0] && "r" in successes[0] ? successes[0].r.transaction : "0x");
  });
});
