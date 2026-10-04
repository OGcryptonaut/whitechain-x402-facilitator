// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { toFacilitatorEvmSigner } from "@x402/evm";
import type { NetworkConfig } from "../config.js";
import { SettleGasCapError } from "../errors.js";
import { settlementContext } from "./context.js";
import type { Logger } from "../logger.js";

/** Contract functions whose eth_call simulation stands in for a settlement broadcast. */
const SETTLEMENT_FUNCTIONS = new Set(["transferWithAuthorization", "settle", "settleWithPermit"]);

/** After this long without a broadcast the local nonce is re-synced from the RPC. */
const NONCE_RESYNC_MS = 60_000;
const MAX_TRACKED_TX = 10_000;
const FEE_CACHE_MS = 15_000;

export interface TxCost {
  /** gasUsed * effectiveGasPrice (+ L1 data fee on OP Stack when the RPC reports it). */
  costWei: bigint;
  gasUsed: bigint;
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface NetworkSignerOptions {
  maxSettleGas: bigint;
  confirmationTimeoutMs: number;
  logger: Logger;
}

export function toChain(network: NetworkConfig): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: network.nativeSymbol, symbol: network.nativeSymbol, decimals: network.nativeDecimals },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: network.explorerUrl
      ? { default: { name: "explorer", url: network.explorerUrl } }
      : undefined,
    testnet: network.testnet,
  });
}

/**
 * One facilitator signer per network: a viem public + wallet client pair wrapped as the
 * `FacilitatorEvmSigner` that @x402/evm's scheme implementations drive. The wrapper adds what a
 * public gas sponsor needs on top of the SDK:
 *
 * - a hard per-transaction gas cap (checked at simulation *and* broadcast),
 * - serialized broadcasts with explicit nonces (concurrent settles never collide),
 * - receipt capture so every settlement's real gas cost feeds the daily budgets and metrics.
 */
export class NetworkSigner {
  readonly network: NetworkConfig;
  readonly chain: Chain;
  readonly address: Address;
  readonly publicClient: PublicClient;
  readonly facilitatorSigner: FacilitatorEvmSigner;
  private readonly walletClient: WalletClient;
  private readonly account: PrivateKeyAccount;
  private readonly opts: NetworkSignerOptions;
  private readonly log: Logger;
  private readonly txCosts = new Map<Hash, TxCost>();
  private broadcastQueue: Promise<unknown> = Promise.resolve();
  private nextNonce: number | undefined;
  private lastBroadcastAt = 0;
  private feeCache: { at: number; maxFeePerGas: bigint } | undefined;

  constructor(network: NetworkConfig, account: PrivateKeyAccount, opts: NetworkSignerOptions) {
    this.network = network;
    this.chain = toChain(network);
    this.account = account;
    this.address = account.address;
    this.opts = opts;
    this.log = opts.logger.child({ network: network.id });
    const transport = http(network.rpcUrl, { batch: false, retryCount: 2, timeout: 20_000 });
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.walletClient = createWalletClient({ account, chain: this.chain, transport });
    this.facilitatorSigner = toFacilitatorEvmSigner(
      {
        address: this.address,
        readContract: (args) => this.readContract(args),
        verifyTypedData: (args) => this.verifyTypedData(args),
        writeContract: (args) => this.writeContract(args),
        sendTransaction: (args) => this.sendTransaction(args),
        waitForTransactionReceipt: (args) => this.waitForTransactionReceipt(args),
        getCode: (args) => this.publicClient.getCode({ address: args.address }),
      },
      { confirmationTimeoutMs: network.confirmationTimeoutMs ?? opts.confirmationTimeoutMs },
    );
  }

  // ------------------------------------------------------------------ FacilitatorEvmSigner

  private async readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown> {
    // eth_call `from` = the facilitator: the Upto proxy checks msg.sender against the witness's
    // facilitator address, so a simulation from the zero address would always revert.
    const call = {
      address: args.address,
      abi: args.abi as Abi,
      functionName: args.functionName,
      args: args.args as readonly unknown[] | undefined,
      account: this.address,
    };
    if (!SETTLEMENT_FUNCTIONS.has(args.functionName)) {
      return this.publicClient.readContract(call);
    }
    // The SDK simulates a settlement with eth_call. Run the gas estimate alongside it so a token
    // whose transfer burns more gas than the facilitator is willing to sponsor fails verification
    // instead of failing (and costing gas) at settlement.
    const [result, gas] = await Promise.all([
      this.publicClient.readContract(call),
      this.publicClient.estimateContractGas(call),
    ]);
    this.assertGasCap(gas);
    return result;
  }

  private async verifyTypedData(args: {
    address: Address;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: Hex;
  }): Promise<boolean> {
    // viem's verifyTypedData covers EOAs (ecrecover) and contracts (ERC-1271 / ERC-6492).
    return this.publicClient.verifyTypedData({
      address: args.address,
      domain: args.domain as never,
      types: args.types as never,
      primaryType: args.primaryType as never,
      message: args.message as never,
      signature: args.signature,
    });
  }

  private async writeContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    gas?: bigint;
    dataSuffix?: Hex;
  }): Promise<Hash> {
    const request = {
      address: args.address,
      abi: args.abi as Abi,
      functionName: args.functionName,
      args: args.args,
      account: this.account,
      chain: this.chain,
      dataSuffix: args.dataSuffix,
    };
    const estimated = await this.publicClient.estimateContractGas({ ...request, account: this.address });
    this.assertGasCap(estimated);
    const gas = this.gasLimitFor(estimated, args.gas);
    return this.broadcast((nonce) => this.walletClient.writeContract({ ...request, gas, nonce }));
  }

  private async sendTransaction(args: { to: Address; data: Hex }): Promise<Hash> {
    const estimated = await this.publicClient.estimateGas({ account: this.address, to: args.to, data: args.data });
    this.assertGasCap(estimated);
    const gas = this.gasLimitFor(estimated);
    return this.broadcast((nonce) =>
      this.walletClient.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: args.to,
        data: args.data,
        gas,
        nonce,
      }),
    );
  }

  private async waitForTransactionReceipt(args: {
    hash: Hash;
    timeout?: number;
  }): Promise<{ status: string; logs?: TransactionReceipt["logs"] }> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: args.hash,
      timeout: args.timeout,
      // Whitechain blocks are ~1s; polling faster than the default 4s shortens settle latency.
      pollingInterval: 1_000,
    });
    this.recordReceipt(receipt);
    return receipt;
  }

  // ------------------------------------------------------------------ gas policy

  private assertGasCap(estimated: bigint): void {
    const store = settlementContext.getStore();
    if (store) store.estimatedGas = estimated;
    if (estimated > this.opts.maxSettleGas) {
      const error = new SettleGasCapError(estimated, this.opts.maxSettleGas);
      if (store) store.gasCap = error;
      throw error;
    }
  }

  private gasLimitFor(estimated: bigint, requested?: bigint): bigint {
    const padded = (estimated * 12n) / 10n;
    const limit = padded > this.opts.maxSettleGas ? this.opts.maxSettleGas : padded;
    if (requested !== undefined && requested > 0n && requested < limit) return requested;
    return limit;
  }

  /**
   * Serializes broadcasts for this signer and assigns explicit nonces: the next nonce is
   * max(pending count from RPC, last local nonce + 1), falling back to the RPC after a quiet
   * period so a dropped transaction cannot wedge the queue forever.
   */
  private broadcast(send: (nonce: number) => Promise<Hash>): Promise<Hash> {
    const run = async (): Promise<Hash> => {
      const pending = await this.publicClient.getTransactionCount({ address: this.address, blockTag: "pending" });
      let nonce = pending;
      if (
        this.nextNonce !== undefined &&
        this.nextNonce > pending &&
        Date.now() - this.lastBroadcastAt < NONCE_RESYNC_MS
      ) {
        nonce = this.nextNonce;
      }
      const hash = await send(nonce);
      this.nextNonce = nonce + 1;
      this.lastBroadcastAt = Date.now();
      return hash;
    };
    const result = this.broadcastQueue.then(run, run);
    this.broadcastQueue = result.catch(() => undefined);
    return result;
  }

  private recordReceipt(receipt: TransactionReceipt): void {
    const raw = receipt as TransactionReceipt & { l1Fee?: bigint | Hex | null };
    let cost = receipt.gasUsed * receipt.effectiveGasPrice;
    if (raw.l1Fee !== undefined && raw.l1Fee !== null) {
      cost += typeof raw.l1Fee === "bigint" ? raw.l1Fee : BigInt(raw.l1Fee);
    }
    if (this.txCosts.size >= MAX_TRACKED_TX) {
      const oldest = this.txCosts.keys().next().value;
      if (oldest) this.txCosts.delete(oldest);
    }
    this.txCosts.set(receipt.transactionHash, {
      costWei: cost,
      gasUsed: receipt.gasUsed,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
    });
  }

  /** Returns and forgets the recorded cost of a transaction this signer waited for. */
  takeTxCost(hash: string | undefined): TxCost | undefined {
    if (!hash) return undefined;
    const cost = this.txCosts.get(hash as Hash);
    if (cost) this.txCosts.delete(hash as Hash);
    return cost;
  }

  /** Looks up a receipt for a hash the SDK reported without waiting (best effort, one RPC call). */
  async fetchTxCost(hash: string): Promise<TxCost | undefined> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash: hash as Hash });
      this.recordReceipt(receipt);
      return this.takeTxCost(hash);
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------ chain reads

  /** Current maxFeePerGas (cached briefly). */
  async maxFeePerGas(): Promise<bigint> {
    const now = Date.now();
    if (this.feeCache && now - this.feeCache.at < FEE_CACHE_MS) return this.feeCache.maxFeePerGas;
    let maxFeePerGas: bigint;
    try {
      ({ maxFeePerGas } = await this.publicClient.estimateFeesPerGas());
    } catch {
      maxFeePerGas = await this.publicClient.getGasPrice();
    }
    this.feeCache = { at: now, maxFeePerGas };
    return maxFeePerGas;
  }

  /** Estimated native cost of one settlement at current fees. */
  async estimatedSettleCostWei(gasUnits: bigint): Promise<bigint> {
    return gasUnits * (await this.maxFeePerGas());
  }

  async balance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.address });
  }

  async chainIdMatches(): Promise<{ ok: boolean; actual: number }> {
    const actual = await this.publicClient.getChainId();
    return { ok: actual === this.network.chainId, actual };
  }

  async hasCode(address: Address): Promise<boolean> {
    const code = await this.publicClient.getCode({ address });
    return !!code && code !== "0x";
  }

  get logger(): Logger {
    return this.log;
  }
}
