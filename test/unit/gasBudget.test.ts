import { describe, expect, it } from "vitest";
import { GasBudget, type BudgetScope } from "../../src/policy/gasBudget.js";

const DAY = 24 * 60 * 60 * 1000;

describe("GasBudget", () => {
  const scopes = (globalLimit: bigint | null, payToLimit: bigint | null): BudgetScope[] => [
    { key: "global", limitWei: globalLimit },
    { key: "payto:0xabc", limitWei: payToLimit },
  ];

  it("reserves, settles with the real cost and refuses once a scope is exhausted", () => {
    const budget = new GasBudget({ now: () => Date.UTC(2026, 0, 1, 12) });
    const first = budget.reserve(scopes(1000n, 300n), 200n);
    expect(first.ok).toBe(true);
    // reservation counts until settled
    expect(budget.reservedNow("global")).toBe(200n);
    const second = budget.reserve(scopes(1000n, 300n), 200n);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.scope.key).toBe("payto:0xabc");
      expect(second.remainingWei).toBe(100n);
    }
    first.reservation!.settle(150n);
    expect(budget.reservedNow("global")).toBe(0n);
    expect(budget.spentToday("global")).toBe(150n);
    expect(budget.spentToday("payto:0xabc")).toBe(150n);
    expect(budget.totalSpent).toBe(150n);
    // 150 spent + 200 > 300 -> refused for payTo, fine globally
    const third = budget.reserve(scopes(1000n, 300n), 200n);
    expect(third.ok).toBe(false);
    const other = budget.reserve([{ key: "global", limitWei: 1000n }, { key: "payto:0xdef", limitWei: 300n }], 200n);
    expect(other.ok).toBe(true);
    other.reservation!.release();
    expect(budget.spentToday("global")).toBe(150n);
  });

  it("treats null limits as unlimited and 0 as a kill switch", () => {
    const budget = new GasBudget({ now: () => Date.UTC(2026, 0, 1) });
    expect(budget.check([{ key: "global", limitWei: null }], 10n ** 30n).ok).toBe(true);
    expect(budget.check([{ key: "global", limitWei: 0n }], 1n).ok).toBe(false);
  });

  it("resets at 00:00 UTC and reports the time until reset", () => {
    let now = Date.UTC(2026, 5, 15, 23, 59, 30);
    const budget = new GasBudget({ now: () => now });
    budget.record([{ key: "global", limitWei: 100n }], 90n);
    expect(budget.spentToday("global")).toBe(90n);
    expect(budget.secondsUntilReset()).toBe(30);
    expect(budget.currentDay()).toBe("2026-06-15");
    now += 60_000;
    expect(budget.currentDay()).toBe("2026-06-16");
    expect(budget.spentToday("global")).toBe(0n);
    expect(budget.totalSpent).toBe(90n); // all-time total survives the roll
    expect(budget.secondsUntilReset()).toBe(DAY / 1000 - 30);
  });

  it("settling a reservation after midnight charges the new day and drops the stale reservation", () => {
    let now = Date.UTC(2026, 0, 1, 23, 59, 59);
    const budget = new GasBudget({ now: () => now });
    const r = budget.reserve([{ key: "global", limitWei: 1000n }], 100n);
    now += 2_000;
    r.reservation!.settle(80n);
    expect(budget.spentToday("global")).toBe(80n);
    expect(budget.reservedNow("global")).toBe(0n);
  });

  it("applies negative corrections without going below zero", () => {
    const budget = new GasBudget({ now: () => Date.UTC(2026, 0, 1) });
    budget.record([{ key: "global", limitWei: null }], 50n);
    budget.record([{ key: "global", limitWei: null }], -80n);
    expect(budget.spentToday("global")).toBe(0n);
    expect(budget.totalSpent).toBe(0n);
  });

  it("a reservation can only be finished once", () => {
    const budget = new GasBudget({ now: () => Date.UTC(2026, 0, 1) });
    const r = budget.reserve([{ key: "global", limitWei: null }], 10n);
    r.reservation!.settle(5n);
    r.reservation!.settle(5n);
    r.reservation!.release();
    expect(budget.spentToday("global")).toBe(5n);
  });
});
