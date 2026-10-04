// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Daily gas budgets, in wei of the network's native token, reset at 00:00 UTC.
 *
 * A settlement first *reserves* an estimated cost under every scope it touches (global, payTo,
 * optional API key). When the transaction's receipt is known the reservation is replaced by the
 * real cost; if the settlement never broadcasts the reservation is released. Reservations make
 * the budget safe under concurrent settles.
 */
export interface BudgetScope {
  /** Scope key, e.g. "global", "payto:0xabc…", "apikey:merchant-a". */
  key: string;
  /** Budget for this scope; null = unlimited. */
  limitWei: bigint | null;
}

export interface Reservation {
  /** Replace the reservation with the real cost (may be 0n). */
  settle(actualWei: bigint): void;
  /** Drop the reservation without spending. */
  release(): void;
}

export type BudgetCheck = { ok: true } | { ok: false; scope: BudgetScope; spentWei: bigint; remainingWei: bigint };

interface ScopeState {
  spent: bigint;
  reserved: bigint;
}

export interface GasBudgetOptions {
  now?: () => number;
  /** Max number of distinct scope keys kept per day (LRU eviction). */
  maxKeys?: number;
}

export class GasBudget {
  private day = "";
  private scopes = new Map<string, ScopeState>();
  private totalSpentAllTime = 0n;
  private settlesAllTime = 0;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: GasBudgetOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  /** Returns the first scope whose budget would be exceeded by `amountWei`, without reserving. */
  check(scopes: BudgetScope[], amountWei: bigint): BudgetCheck {
    this.rollDay();
    for (const scope of scopes) {
      if (scope.limitWei === null) continue;
      const state = this.scopes.get(scope.key) ?? { spent: 0n, reserved: 0n };
      const committed = state.spent + state.reserved;
      if (committed + amountWei > scope.limitWei) {
        const remaining = scope.limitWei - committed;
        return { ok: false, scope, spentWei: state.spent, remainingWei: remaining < 0n ? 0n : remaining };
      }
    }
    return { ok: true };
  }

  /** Atomically checks and reserves `amountWei` under all scopes. */
  reserve(scopes: BudgetScope[], amountWei: bigint): BudgetCheck & { reservation?: Reservation } {
    const check = this.check(scopes, amountWei);
    if (!check.ok) return check;
    const day = this.day;
    for (const scope of scopes) {
      const state = this.touch(scope.key);
      state.reserved += amountWei;
    }
    let done = false;
    const finish = (actualWei: bigint | null) => {
      if (done) return;
      done = true;
      // If the day rolled over while the tx was pending, charge the new day: budgets are about
      // protecting the wallet from now on, not accounting precision.
      this.rollDay();
      for (const scope of scopes) {
        const state = this.touch(scope.key);
        if (day === this.day) state.reserved = state.reserved > amountWei ? state.reserved - amountWei : 0n;
        if (actualWei !== null) state.spent += actualWei;
      }
      if (actualWei !== null) {
        this.totalSpentAllTime += actualWei;
        this.settlesAllTime += 1;
      }
    };
    return {
      ok: true,
      reservation: {
        settle: (actualWei) => finish(actualWei),
        release: () => finish(null),
      },
    };
  }

  /**
   * Records a cost (or a correction, when negative) without a prior reservation, e.g. the delta
   * between an estimated and the real cost of a transaction that confirmed late.
   */
  record(scopes: BudgetScope[], deltaWei: bigint): void {
    this.rollDay();
    for (const scope of scopes) {
      const state = this.touch(scope.key);
      state.spent = state.spent + deltaWei < 0n ? 0n : state.spent + deltaWei;
    }
    this.totalSpentAllTime = this.totalSpentAllTime + deltaWei < 0n ? 0n : this.totalSpentAllTime + deltaWei;
    if (deltaWei > 0n) this.settlesAllTime += 1;
  }

  spentToday(key: string): bigint {
    this.rollDay();
    return this.scopes.get(key)?.spent ?? 0n;
  }

  reservedNow(key: string): bigint {
    this.rollDay();
    return this.scopes.get(key)?.reserved ?? 0n;
  }

  get totalSpent(): bigint {
    return this.totalSpentAllTime;
  }

  get settles(): number {
    return this.settlesAllTime;
  }

  /** Seconds until the next 00:00 UTC reset. */
  secondsUntilReset(): number {
    const now = this.now();
    const next = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + 1,
    );
    return Math.max(1, Math.ceil((next - now) / 1000));
  }

  currentDay(): string {
    this.rollDay();
    return this.day;
  }

  private rollDay(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.scopes = new Map();
    }
  }

  private touch(key: string): ScopeState {
    let state = this.scopes.get(key);
    if (state) {
      this.scopes.delete(key);
    } else {
      state = { spent: 0n, reserved: 0n };
    }
    this.scopes.set(key, state);
    while (this.scopes.size > this.maxKeys) {
      const oldest = this.scopes.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.scopes.delete(oldest);
    }
    return state;
  }
}
