// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permit2 flows on anvil with Permit2 and the x402 proxies at their canonical addresses (deployed
 * through the same CREATE2 path as scripts/deploy-permit2-proxies.ts):
 *  - `exact` via Permit2 (payer pre-approved Permit2),
 *  - `exact` via Permit2 with EIP-2612 gas sponsoring (payer never sends a transaction),
 *  - `upto` (metered, facilitator-bound witness).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme as UptoEvmClientScheme } from "@x402/evm/upto/client";
import { toClientEvmSigner, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from "@x402/evm";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseEther, type Address } from "viem";
import { ANVIL_KEYS, startAnvil, type AnvilInstance } from "../helpers/anvil.js";
import { deployFixtures, type ChainFixture } from "../helpers/chain.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { startExpressMerchant, type RunningMerchant } from "../helpers/merchant.js";
import { checkDeployment, PROXIES } from "../../scripts/lib/permit2-proxies.js";

const PRICE = "25000";

let anvil: AnvilInstance;
let chain: ChainFixture;
let facilitator: RunningFacilitator;
let network: Network;
let payTo: Address;

beforeAll(async () => {
  anvil = await startAnvil({ chainId: 1874001 });
  chain = await deployFixtures(anvil, { permit2: true });
  network = `eip155:${anvil.chainId}`;
  payTo = privateKeyToAccount(generatePrivateKey()).address;
  facilitator = await startFacilitator(anvil, ANVIL_KEYS[9]);
});

afterAll(async () => {
  await facilitator?.stop();
  await anvil?.stop();
});

describe("canonical Permit2 proxy deployment", () => {
  it("the vendored init codes reproduce the canonical x402 proxy addresses on this chain", async () => {
    const status = await checkDeployment(chain.publicClient);
    expect(status).toMatchObject({ deployer: true, permit2: true, exact: true, upto: true });
    expect(PROXIES.exact.address.toLowerCase()).toBe(x402ExactPermit2ProxyAddress.toLowerCase());
    expect(PROXIES.upto.address.toLowerCase()).toBe(x402UptoPermit2ProxyAddress.toLowerCase());
    // The proxies point at canonical Permit2.
    const permit2 = await chain.publicClient.readContract({
      address: PROXIES.exact.address,
      abi: [{ type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "PERMIT2",
    });
    expect((permit2 as string).toLowerCase()).toBe("0x000000000022d473030f116ddee9f6b43ac78ba3");
  });

  it("the facilitator detects the Upto proxy and advertises `upto`", async () => {
    const supported = await new HTTPFacilitatorClient({ url: facilitator.url }).getSupported();
    const upto = supported.kinds.find((k) => k.scheme === "upto");
    expect(upto).toBeDefined();
    expect(upto?.network).toBe(network);
    expect(upto?.extra).toMatchObject({ facilitatorAddress: facilitator.service.address });
    const health = (await (await fetch(`${facilitator.url}/health`)).json()) as {
      networks: { permit2: { deployed: boolean; exactProxy: boolean; uptoProxy: boolean }; schemes: string[] }[];
    };
    expect(health.networks[0]?.permit2).toMatchObject({ deployed: true, exactProxy: true, uptoProxy: true });
    expect(health.networks[0]?.schemes).toEqual(expect.arrayContaining(["exact", "upto"]));
  });
});

describe("exact via Permit2", () => {
  let payer: PrivateKeyAccount;
  let merchant: RunningMerchant;

  beforeAll(async () => {
    payer = privateKeyToAccount(generatePrivateKey());
    await chain.mint(chain.token, payer.address, 1_000_000n);
    await chain.fund(payer.address, parseEther("0.1")); // for the one-off Permit2 approval
    await chain.approvePermit2(payer, chain.token);
    merchant = await startExpressMerchant({
      facilitatorUrl: facilitator.url,
      network,
      payTo,
      asset: chain.token,
      assetName: chain.tokenName,
      assetVersion: chain.tokenVersion,
      amount: PRICE,
      assetTransferMethod: "permit2",
    });
  });

  afterAll(async () => {
    await merchant?.stop();
  });

  it("settles through x402ExactPermit2Proxy", async () => {
    const payerBefore = await chain.balanceOf(chain.token, payer.address);
    const merchantBefore = await chain.balanceOf(chain.token, payTo);
    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network, client: new ExactEvmClientScheme(payer) }],
      spendControls: false,
    });
    const res = await fetchWithPayment(`${merchant.url}/paid`);
    expect(res.status).toBe(200);
    const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settlement.success).toBe(true);
    const receipt = await chain.publicClient.getTransaction({ hash: settlement.transaction as `0x${string}` });
    expect(receipt.to?.toLowerCase()).toBe(PROXIES.exact.address.toLowerCase());
    expect(receipt.from.toLowerCase()).toBe(facilitator.service.address.toLowerCase());
    expect(await chain.balanceOf(chain.token, payer.address)).toBe(payerBefore - BigInt(PRICE));
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));
  });
});

describe("exact via Permit2 with EIP-2612 gas sponsoring (fully gasless payer)", () => {
  let payer: PrivateKeyAccount;
  let merchant: RunningMerchant;

  beforeAll(async () => {
    payer = privateKeyToAccount(generatePrivateKey()); // no gas, no Permit2 approval
    await chain.mint(chain.token, payer.address, 1_000_000n);
    merchant = await startExpressMerchant({
      facilitatorUrl: facilitator.url,
      network,
      payTo,
      asset: chain.token,
      assetName: chain.tokenName,
      assetVersion: chain.tokenVersion,
      amount: PRICE,
      assetTransferMethod: "permit2",
      eip2612: true,
    });
  });

  afterAll(async () => {
    await merchant?.stop();
  });

  it("the facilitator submits settleWithPermit; the payer never sends a transaction", async () => {
    expect(await chain.nativeBalance(payer.address)).toBe(0n);
    const merchantBefore = await chain.balanceOf(chain.token, payTo);
    const signer = toClientEvmSigner(payer, chain.publicClient);
    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network, client: new ExactEvmClientScheme(signer) }],
      spendControls: false,
    });
    const res = await fetchWithPayment(`${merchant.url}/paid`);
    expect(res.status).toBe(200);
    const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settlement.success).toBe(true);
    const tx = await chain.publicClient.getTransaction({ hash: settlement.transaction as `0x${string}` });
    expect(tx.to?.toLowerCase()).toBe(PROXIES.exact.address.toLowerCase());
    // settleWithPermit selector differs from settle; either way the payer paid no gas.
    expect(await chain.nativeBalance(payer.address)).toBe(0n);
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));
    expect(await chain.publicClient.getTransactionCount({ address: payer.address })).toBe(0);
  });
});

describe("upto (Permit2, facilitator-bound witness)", () => {
  let payer: PrivateKeyAccount;
  let merchant: RunningMerchant;

  beforeAll(async () => {
    payer = privateKeyToAccount(generatePrivateKey());
    await chain.mint(chain.token, payer.address, 1_000_000n);
    await chain.fund(payer.address, parseEther("0.1"));
    await chain.approvePermit2(payer, chain.token);
    merchant = await startExpressMerchant({
      facilitatorUrl: facilitator.url,
      network,
      payTo,
      asset: chain.token,
      assetName: chain.tokenName,
      assetVersion: chain.tokenVersion,
      amount: PRICE,
      upto: true,
    });
  });

  afterAll(async () => {
    await merchant?.stop();
  });

  it("settles through x402UptoPermit2Proxy for the full amount by default", async () => {
    const merchantBefore = await chain.balanceOf(chain.token, payTo);
    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network, client: new UptoEvmClientScheme(payer) }],
      spendControls: false,
    });
    const res = await fetchWithPayment(`${merchant.url}/upto`);
    expect(res.status).toBe(200);
    const settlement = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settlement.success).toBe(true);
    expect(settlement.amount).toBe(PRICE);
    const tx = await chain.publicClient.getTransaction({ hash: settlement.transaction as `0x${string}` });
    expect(tx.to?.toLowerCase()).toBe(PROXIES.upto.address.toLowerCase());
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));
  });
});
