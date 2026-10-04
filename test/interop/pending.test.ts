// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Slow-chain behaviour: when a settlement is broadcast but not confirmed within
 * CONFIRMATION_TIMEOUT_MS the facilitator answers `settlement_pending` with the tx hash (the
 * official resource server retries once), and the retry reconciles against the broadcast tx
 * instead of sending a second one. Gas accounting must count the transaction exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { createTestClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ANVIL_KEYS, startAnvil, type AnvilInstance } from "../helpers/anvil.js";
import { anvilChain, deployFixtures, type ChainFixture } from "../helpers/chain.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { buildEip3009Payment, requirementsFor } from "../helpers/payments.js";

let anvil: AnvilInstance;
let chain: ChainFixture;
let facilitator: RunningFacilitator;
let network: Network;
let payer: PrivateKeyAccount;

beforeAll(async () => {
  anvil = await startAnvil({ chainId: 31338 });
  chain = await deployFixtures(anvil, { permit2: false });
  network = `eip155:${anvil.chainId}`;
  payer = privateKeyToAccount(generatePrivateKey());
  await chain.mint(chain.token, payer.address, 1_000_000n);
  facilitator = await startFacilitator(anvil, ANVIL_KEYS[9], { CONFIRMATION_TIMEOUT_MS: "1500" });
});

afterAll(async () => {
  await facilitator?.stop();
  await anvil?.stop();
});

describe("settlement_pending and retry reconciliation", () => {
  it("reports settlement_pending with the tx hash, then reconciles on retry without a second broadcast", async () => {
    const testClient = createTestClient({ chain: anvilChain(anvil), transport: http(anvil.url), mode: "anvil" });
    const client = new HTTPFacilitatorClient({ url: facilitator.url });
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const requirements = requirementsFor({
      network,
      asset: chain.token,
      payTo,
      amount: "10000",
      name: chain.tokenName,
      version: chain.tokenVersion,
    });
    const payload = await buildEip3009Payment(payer, requirements);

    await testClient.setAutomine(false);
    let pending;
    try {
      pending = await client.settle(payload, requirements);
    } finally {
      // Confirm the broadcast transaction, then let later tests mine instantly again.
      await testClient.mine({ blocks: 1 });
      await testClient.setAutomine(true);
    }
    expect(pending.success).toBe(false);
    expect(pending.errorReason).toBe("settlement_pending");
    expect(pending.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    const metricsAfterPending = (await (await fetch(`${facilitator.url}/metrics`)).json()) as {
      settle: { pending: number; success: number };
      gas: { txCount: number };
    };
    expect(metricsAfterPending.settle.pending).toBe(1);

    const retry = await client.settle(payload, requirements);
    expect(retry.success).toBe(true);
    expect(retry.transaction).toBe(pending.transaction); // reconciled, not re-broadcast
    expect(await chain.balanceOf(chain.token, payTo)).toBe(10000n);
    expect(await chain.publicClient.getTransactionCount({ address: facilitator.service.address })).toBe(1);

    const metrics = (await (await fetch(`${facilitator.url}/metrics`)).json()) as {
      settle: { pending: number; success: number };
      gas: { txCount: number; spentWei: Record<string, string> };
      budget: { globalSpentTodayWei: string };
    };
    expect(metrics.settle.success).toBe(1);
    expect(metrics.gas.txCount).toBe(1);
    const receipt = await chain.publicClient.getTransactionReceipt({ hash: retry.transaction as `0x${string}` });
    expect(BigInt(metrics.budget.globalSpentTodayWei)).toBe(receipt.gasUsed * receipt.effectiveGasPrice);
  });
});
