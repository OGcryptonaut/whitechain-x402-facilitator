// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tracks authorizations that are being settled right now or were settled recently, so a replayed
 * payload is refused before it reaches the chain (saving the facilitator a doomed, gas-burning
 * broadcast) and a merchant never serves the same payment twice concurrently.
 *
 * Keys are derived from the payload's on-chain replay protection: `network|asset|from|nonce` for
 * EIP-3009 and `network|permit2|from|nonce` for Permit2, so two different tokens or networks can
 * legitimately share a nonce.
 */
export type DedupeState = { kind: "in-flight" } | { kind: "settled"; transaction: string; at: number };

export interface AuthorizationRegistryOptions {
  /** How long a settled key is remembered. */
  settledTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class AuthorizationRegistry {
  private readonly entries = new Map<string, DedupeState>();
  private readonly settledTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: AuthorizationRegistryOptions = {}) {
    this.settledTtlMs = opts.settledTtlMs ?? 6 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 100_000;
    this.now = opts.now ?? (() => Date.now());
  }

  lookup(key: string): DedupeState | undefined {
    const state = this.entries.get(key);
    if (!state) return undefined;
    if (state.kind === "settled" && this.now() - state.at > this.settledTtlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return state;
  }

  /** Marks the key in-flight. Returns false when it is already in-flight or settled. */
  begin(key: string): boolean {
    if (this.lookup(key)) return false;
    this.entries.set(key, { kind: "in-flight" });
    this.evict();
    return true;
  }

  /** Records a successful settlement for the key. */
  settled(key: string, transaction: string): void {
    this.entries.set(key, { kind: "settled", transaction, at: this.now() });
    this.evict();
  }

  /** Clears an in-flight mark (settle failed before/at broadcast, or is pending retry). */
  end(key: string): void {
    const state = this.entries.get(key);
    if (state?.kind === "in-flight") this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = this.now();
    for (const [key, state] of this.entries) {
      if (state.kind === "settled" && now - state.at > this.settledTtlMs) this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) return;
    }
    for (const [key, state] of this.entries) {
      if (state.kind === "settled") this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) return;
    }
  }
}

export type PayloadKind = "permit2" | "eip3009" | "unknown";

/**
 * Which settlement path @x402/evm will take for a payload. This MUST mirror the SDK's own routing
 * (`isPermit2Payload`: the mere presence of `permit2Authorization` selects Permit2), otherwise a
 * payload carrying both an `authorization` decoy and a real `permit2Authorization` would be
 * screened (denylist, rate limits, dedupe) on the decoy and settled for the real payer.
 */
export function payloadKind(payload: Record<string, unknown> | undefined): PayloadKind {
  if (!payload) return "unknown";
  if ("permit2Authorization" in payload) return "permit2";
  if ("authorization" in payload) return "eip3009";
  return "unknown";
}

function innerAuthorization(payload: Record<string, unknown>, kind: PayloadKind): Record<string, unknown> | undefined {
  if (kind === "unknown") return undefined;
  const inner = payload[kind === "permit2" ? "permit2Authorization" : "authorization"];
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
}

/**
 * Canonical form of a nonce so trivially different spellings of the same on-chain nonce
 * ("1", "01", "0x1" for Permit2's uint256; mixed-case hex for EIP-3009's bytes32) share one key.
 */
export function normalizeNonce(kind: PayloadKind, nonce: string): string {
  if (kind === "permit2" && /^(\d+|0x[0-9a-fA-F]+)$/.test(nonce)) return BigInt(nonce).toString();
  return nonce.toLowerCase();
}

/** Builds the dedupe key for a payment payload, or undefined when the payload shape is unknown. */
export function authorizationKey(
  network: string,
  asset: string,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (!payload) return undefined;
  const kind = payloadKind(payload);
  const auth = innerAuthorization(payload, kind);
  if (!auth || typeof auth["from"] !== "string" || typeof auth["nonce"] !== "string") return undefined;
  const from = auth["from"].toLowerCase();
  const nonce = normalizeNonce(kind, auth["nonce"]);
  return kind === "permit2" ? `${network}|permit2|${from}|${nonce}` : `${network}|${asset.toLowerCase()}|${from}|${nonce}`;
}

/** Extracts the payer address claimed by a payload (unverified; for screening and rate limits only). */
export function claimedPayer(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const auth = innerAuthorization(payload, payloadKind(payload));
  const from = auth?.["from"];
  return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : undefined;
}
