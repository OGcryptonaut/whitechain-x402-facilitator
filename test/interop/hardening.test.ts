// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Adversarial regression suite (see VERIFICATION.md). Each case is an attack an anonymous caller
 * could try against a public gas sponsor; the facilitator under test runs against its own anvil
 * with the real @x402/core + @x402/evm stack, and every refusal is checked to have cost no gas.
 */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError, type Network } from "@x402/core/types";
import { x402ExactPermit2ProxyAddress } from "@x402/evm";
import { parseEther, serializeErc6492Signature, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ANVIL_KEYS, startAnvil, type AnvilInstance } from "../helpers/anvil.js";
import { deployFixtures, type ChainFixture } from "../helpers/chain.js";
import { startFacilitator, type RunningFacilitator } from "../helpers/facilitator.js";
import { buildEip3009Payment, postJson, requirementsFor } from "../helpers/payments.js";
import { StaticDenylist } from "../../src/policy/denylist.js";
import { GasBudget } from "../../src/policy/gasBudget.js";

const PRICE = "10000";

let anvil: AnvilInstance;
let chain: ChainFixture;
let facilitator: RunningFacilitator;
let network: Network;
let payer: PrivateKeyAccount;
let payTo: Address;

type VerifyBody = { isValid: boolean; invalidReason?: string; invalidMessage?: string };
type SettleBody = { success: boolean; errorReason?: string; errorMessage?: string; transaction: string };

const reqs = (overrides: Partial<ReturnType<typeof requirementsFor>> = {}) => ({
  ...requirementsFor({ network, asset: chain.token, payTo, amount: PRICE, name: chain.tokenName, version: chain.tokenVersion }),
  ...overrides,
});
const wire = (paymentPayload: unknown, paymentRequirements: unknown) => ({ x402Version: 2, paymentPayload, paymentRequirements });
const nonceOf = (address: Address) => chain.publicClient.getTransactionCount({ address });

beforeAll(async () => {
  anvil = await startAnvil({ chainId: 31400 });
  chain = await deployFixtures(anvil, { permit2: false });
  network = `eip155:${anvil.chainId}`;
  payer = privateKeyToAccount(generatePrivateKey());
  payTo = privateKeyToAccount(generatePrivateKey()).address;
  await chain.mint(chain.token, payer.address, 10_000_000n);
  facilitator = await startFacilitator(anvil, ANVIL_KEYS[9]);
});

afterAll(async () => {
  await facilitator?.stop();
  await anvil?.stop();
});

describe("payload type confusion (SDK routes on permit2Authorization)", () => {
  const permit2For = (from: Address) => ({
    from,
    spender: x402ExactPermit2ProxyAddress,
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 600),
    permitted: { token: chain.token, amount: PRICE },
    witness: { to: payTo, validAfter: "0" },
  });

  it("a payload carrying both an EIP-3009 authorization and a permit2Authorization is refused as invalid_request", async () => {
    const requirements = reqs();
    const genuine = await buildEip3009Payment(payer, requirements);
    const sanctioned = privateKeyToAccount(generatePrivateKey());
    // Decoy: a clean `authorization` for screening, a Permit2 authorization the SDK would settle.
    const confused = { ...genuine, payload: { ...genuine.payload, permit2Authorization: permit2For(sanctioned.address) } };
    const metricsBefore = (await (await fetch(`${facilitator.url}/metrics`)).json()) as { verify: { errors: number } };

    const verify = await postJson(`${facilitator.url}/verify`, wire(confused, requirements));
    expect(verify.status).toBe(400);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: "invalid_request" });
    expect((verify.body as VerifyBody).invalidMessage).toMatch(/not both/);

    const settle = await postJson(`${facilitator.url}/settle`, wire(confused, requirements));
    expect(settle.status).toBe(400);
    expect(settle.body).toMatchObject({ success: false, errorReason: "invalid_request", transaction: "" });

    const metricsAfter = (await (await fetch(`${facilitator.url}/metrics`)).json()) as { verify: { errors: number } };
    expect(metricsAfter.verify.errors).toBe(metricsBefore.verify.errors); // refused by the schema, never reached the SDK
  });

  it("a Permit2-shaped payload from a denylisted payer is refused at screening (403), before the SDK or the chain", async () => {
    const sanctioned = privateKeyToAccount(generatePrivateKey());
    const denied = await startFacilitator(anvil, ANVIL_KEYS[8], {}, { denylist: new StaticDenylist([sanctioned.address]) });
    try {
      const requirements = reqs();
      const payload = {
        x402Version: 2,
        accepted: requirements,
        payload: { signature: `0x${"11".repeat(65)}`, permit2Authorization: permit2For(sanctioned.address) },
      };
      const verify = await postJson(`${denied.url}/verify`, wire(payload, requirements));
      expect(verify.status).toBe(403);
      expect(verify.body).toMatchObject({ isValid: false, invalidReason: "address_denylisted" });
      const settle = await postJson(`${denied.url}/settle`, wire(payload, requirements));
      expect(settle.status).toBe(403);
      expect(settle.body).toMatchObject({ success: false, errorReason: "address_denylisted", transaction: "" });

      // The same shape from a clean payer passes screening and is judged by the SDK (no proxy here).
      const clean = { ...payload, payload: { ...payload.payload, permit2Authorization: permit2For(payer.address) } };
      const judged = await postJson(`${denied.url}/verify`, wire(clean, requirements));
      expect(judged.status).toBe(200);
      expect(judged.body).toMatchObject({ isValid: false });
      expect((judged.body as VerifyBody).invalidReason).toMatch(/permit2|signature/);
    } finally {
      await denied.stop();
    }
  });

  it("malformed scheme fields are a 400 in protocol shape, never a 500 from inside the SDK", async () => {
    const requirements = reqs();
    const genuine = await buildEip3009Payment(payer, requirements);
    const auth = genuine.payload["authorization"] as Record<string, string>;
    for (const patch of [{ from: "0Xdeadbeef" }, { to: "0x1" }, { value: "1e6" }, { nonce: "0x01" }]) {
      const mangled = { ...genuine, payload: { ...genuine.payload, authorization: { ...auth, ...patch } } };
      const res = await postJson(`${facilitator.url}/verify`, wire(mangled, requirements));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ isValid: false, invalidReason: "invalid_request" });
    }
    const metrics = (await (await fetch(`${facilitator.url}/metrics`)).json()) as { verify: { errors: number } };
    expect(metrics.verify.errors).toBe(0);
  });
});

describe("recipient and amount are fixed by the payer's signature", () => {
  it("settle (not just verify) refuses an authorization signed to a different payTo, with no broadcast", async () => {
    const requirements = reqs();
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    const payload = await buildEip3009Payment(payer, requirements, { to: attacker });
    const nonceBefore = await nonceOf(facilitator.service.address);
    const settle = await new HTTPFacilitatorClient({ url: facilitator.url }).settle(payload, requirements);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_exact_evm_recipient_mismatch");
    expect(settle.transaction).toBe("");
    expect(await nonceOf(facilitator.service.address)).toBe(nonceBefore);
    expect(await chain.balanceOf(chain.token, attacker)).toBe(0n);
  });

  it("a client-chosen accepted.payTo is ignored: funds go where the merchant's requirements and the signature say", async () => {
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements);
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    payload.accepted = { ...requirements, payTo: attacker, amount: "1" };
    const merchantBefore = await chain.balanceOf(chain.token, payTo);
    const settle = await new HTTPFacilitatorClient({ url: facilitator.url }).settle(payload, requirements);
    expect(settle.success).toBe(true);
    expect(await chain.balanceOf(chain.token, payTo)).toBe(merchantBefore + BigInt(PRICE));
    expect(await chain.balanceOf(chain.token, attacker)).toBe(0n);
  });

  it("an ERC-6492 signature naming an attacker's factory is refused and the factory is never called", async () => {
    const requirements = reqs();
    const genuine = await buildEip3009Payment(payer, requirements);
    const factory = privateKeyToAccount(generatePrivateKey()).address;
    const wrapped = serializeErc6492Signature({
      address: factory,
      data: "0xdeadbeef",
      signature: genuine.payload["signature"] as Hex,
    });
    const payload = { ...genuine, payload: { ...genuine.payload, signature: wrapped } };
    const client = new HTTPFacilitatorClient({ url: facilitator.url });
    const verify = await client.verify(payload, requirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("eip6492_factory_not_allowed");
    const nonceBefore = await nonceOf(facilitator.service.address);
    const gasBefore = await chain.nativeBalance(facilitator.service.address);
    const settle = await client.settle(payload, requirements);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("eip6492_factory_not_allowed");
    expect(settle.transaction).toBe("");
    expect(await nonceOf(facilitator.service.address)).toBe(nonceBefore);
    expect(await chain.nativeBalance(facilitator.service.address)).toBe(gasBefore);
  });

  it("the signer exposes nothing the SDK could use to sign messages, typed data or raw transactions", () => {
    const signer = facilitator.service.network(network)!.signer.facilitatorSigner as unknown as Record<string, unknown>;
    expect(Object.keys(signer).sort()).toEqual(
      ["address", "getAddresses", "getCode", "readContract", "sendTransaction", "verifyTypedData", "waitForTransactionReceipt", "writeContract"].sort(),
    );
    for (const forbidden of ["signMessage", "signTypedData", "signTransaction", "sign", "signAuthorization", "sendRawTransaction"]) {
      expect(signer[forbidden]).toBeUndefined();
    }
    expect((signer["getAddresses"] as () => string[])()).toEqual([facilitator.service.address]);
  });
});

describe("cross-network replay", () => {
  let other: AnvilInstance;
  let otherChain: ChainFixture;
  let dual: RunningFacilitator;

  beforeAll(async () => {
    other = await startAnvil({ chainId: 31401 });
    otherChain = await deployFixtures(other, { permit2: false });
    // Same deployer, same nonces: the token lives at the same address on both chains.
    expect(otherChain.token).toBe(chain.token);
    await otherChain.mint(otherChain.token, payer.address, 1_000_000n);
    dual = await startFacilitator(anvil, ANVIL_KEYS[7], {}, {}, { extraNetworks: [other] });
  });

  afterAll(async () => {
    await dual?.stop();
    await other?.stop();
  });

  it("an authorization settled on one network cannot be replayed on another configured network", async () => {
    const client = new HTTPFacilitatorClient({ url: dual.url });
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements);
    const first = await client.settle(payload, requirements);
    expect(first.success).toBe(true);

    const otherNetwork: Network = `eip155:${other.chainId}`;
    const replayRequirements = { ...requirements, network: otherNetwork };
    const replay = { ...payload, accepted: { ...payload.accepted, network: otherNetwork } };
    const verify = await client.verify(replay, replayRequirements);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_exact_evm_signature"); // EIP-712 domain binds the chain id
    const settle = await client.settle(replay, replayRequirements);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_exact_evm_signature");
    expect(settle.transaction).toBe("");
    expect(await otherChain.publicClient.getTransactionCount({ address: dual.service.address })).toBe(0);
    expect(await otherChain.balanceOf(otherChain.token, payTo)).toBe(0n);

    // Same network again: the in-memory registry refuses it before the chain has to.
    const again = (await client.settle(payload, requirements).then(() => undefined, (e: unknown) => e)) as SettleError;
    expect(again).toBeInstanceOf(SettleError);
    expect(again.errorReason).toBe("duplicate_settlement");
    expect(again.statusCode).toBe(409);

    // A payment signed for the other network settles there (the second network works).
    const otherReqs = { ...requirements, network: otherNetwork };
    const otherPayment = await client.settle(await buildEip3009Payment(payer, otherReqs), otherReqs);
    expect(otherPayment.success).toBe(true);
    expect(await otherChain.balanceOf(otherChain.token, payTo)).toBe(BigInt(PRICE));
  });
});

describe("rate limits cannot be sidestepped", () => {
  it("X-Forwarded-For is ignored unless TRUST_PROXY is set", async () => {
    const strict = await startFacilitator(anvil, ANVIL_KEYS[8], { RATE_LIMIT_IP_PER_WINDOW: "2" });
    try {
      const requirements = reqs();
      const body = wire(await buildEip3009Payment(payer, requirements), requirements);
      const spoof = (ip: string) => postJson(`${strict.url}/verify`, body, { "X-Forwarded-For": ip });
      expect((await spoof("203.0.113.1")).status).toBe(200);
      expect((await spoof("203.0.113.2")).status).toBe(200);
      const third = await spoof("203.0.113.3");
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ isValid: false, invalidReason: "rate_limit_exceeded" });
    } finally {
      await strict.stop();
    }

    const proxied = await startFacilitator(anvil, ANVIL_KEYS[8], { RATE_LIMIT_IP_PER_WINDOW: "2", TRUST_PROXY: "true" });
    try {
      const requirements = reqs();
      const body = wire(await buildEip3009Payment(payer, requirements), requirements);
      const from = (ip: string) => postJson(`${proxied.url}/verify`, body, { "X-Forwarded-For": ip });
      expect((await from("198.51.100.1")).status).toBe(200);
      expect((await from("198.51.100.1")).status).toBe(200);
      expect((await from("198.51.100.1")).status).toBe(429); // same forwarded client
      expect((await from("198.51.100.2")).status).toBe(200); // a different one has its own bucket
    } finally {
      await proxied.stop();
    }
  });

  it("the facilitator-wide ceiling caps RPC fan-out even across many source addresses", async () => {
    const capped = await startFacilitator(anvil, ANVIL_KEYS[8], {
      RATE_LIMIT_GLOBAL_PER_WINDOW: "2",
      RATE_LIMIT_IP_PER_WINDOW: "100",
      TRUST_PROXY: "true",
    });
    try {
      const requirements = reqs();
      const body = wire(await buildEip3009Payment(payer, requirements), requirements);
      expect((await postJson(`${capped.url}/verify`, body, { "X-Forwarded-For": "192.0.2.1" })).status).toBe(200);
      expect((await postJson(`${capped.url}/verify`, body, { "X-Forwarded-For": "192.0.2.2" })).status).toBe(200);
      const third = await postJson(`${capped.url}/verify`, body, { "X-Forwarded-For": "192.0.2.3" });
      expect(third.status).toBe(429);
      expect((third.body as VerifyBody).invalidMessage).toContain("facilitator-wide");
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await capped.stop();
    }
  });

  it("an unknown API key is refused before it can touch any bucket or the chain", async () => {
    const res = await postJson(`${facilitator.url}/verify`, wire(await buildEip3009Payment(payer, reqs()), reqs()), { "X-API-Key": "guess" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("X-API-Key");
  });
});

describe("gas cannot be drained past the budgets", () => {
  it("concurrent settles of distinct authorizations cannot overshoot the daily budget by more than one estimate", async () => {
    const gasBudget = new GasBudget();
    const budgeted = await startFacilitator(
      anvil,
      ANVIL_KEYS[6],
      { GAS_BUDGET_GLOBAL_DAILY: "1", GAS_BUDGET_PER_PAYTO_DAILY: "unlimited", SETTLE_GAS_ESTIMATE: "100000" },
      { gasBudget },
    );
    try {
      // Warm the fee cache and read the facilitator's own per-settlement estimate E, then leave
      // exactly 1.9 E of today's budget: one reservation fits, a second does not.
      const health = (await (await fetch(`${budgeted.url}/health`)).json()) as { networks: { estimatedSettleCostWei: string }[] };
      const estimate = BigInt(health.networks[0]!.estimatedSettleCostWei);
      expect(estimate).toBeGreaterThan(0n);
      const limit = parseEther("1");
      gasBudget.record([{ key: "global", limitWei: limit }], limit - (estimate * 19n) / 10n);

      const client = new HTTPFacilitatorClient({ url: budgeted.url });
      const requirements = reqs();
      const payloads = await Promise.all([0, 1, 2].map(() => buildEip3009Payment(payer, requirements)));
      const nonceBefore = await nonceOf(budgeted.service.address);
      const outcomes = await Promise.all(
        payloads.map((p) => client.settle(p, requirements).then((r) => ({ r }), (e: unknown) => ({ e }))),
      );
      const successes = outcomes.filter((o) => "r" in o && o.r.success);
      const refused = outcomes.filter((o): o is { e: SettleError } => "e" in o && o.e instanceof SettleError);
      expect(successes).toHaveLength(1);
      expect(refused).toHaveLength(2);
      for (const { e } of refused) {
        expect(e.statusCode).toBe(429);
        expect(e.errorReason).toBe("gas_budget_exceeded");
      }
      expect(await nonceOf(budgeted.service.address)).toBe(nonceBefore + 1);

      // The reservation was replaced by the real (smaller) cost, so one more sequential settle
      // fits, and the one after that is refused: budgets track what was actually spent.
      const fourth = await client.settle(await buildEip3009Payment(payer, requirements), requirements);
      expect(fourth.success).toBe(true);
      const fifth = (await client.settle(await buildEip3009Payment(payer, requirements), requirements).then(() => undefined, (e: unknown) => e)) as SettleError;
      expect(fifth).toBeInstanceOf(SettleError);
      expect(fifth.errorReason).toBe("gas_budget_exceeded");
      expect(await nonceOf(budgeted.service.address)).toBe(nonceBefore + 2);
    } finally {
      await budgeted.stop();
    }
  });

  it("a token that passes simulation but reverts on chain costs at most one capped transaction, and that cost is charged to the budget", async () => {
    await chain.mint(chain.simOnly, payer.address, 1_000_000n);
    const requirements = requirementsFor({ network, asset: chain.simOnly, payTo, amount: PRICE, name: "Sim Only", version: "1" });
    const payload = await buildEip3009Payment(payer, requirements);
    const client = new HTTPFacilitatorClient({ url: facilitator.url });

    const verify = await client.verify(payload, requirements);
    expect(verify.isValid).toBe(true); // eth_call cannot tell this token apart from an honest one

    const before = (await (await fetch(`${facilitator.url}/metrics`)).json()) as {
      settle: { failed: number };
      gas: { txCount: number };
      budget: { globalSpentTodayWei: string };
    };
    const gasBefore = await chain.nativeBalance(facilitator.service.address);
    const settle = await client.settle(payload, requirements);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_exact_evm_transaction_failed");
    expect(settle.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    const receipt = await chain.publicClient.getTransactionReceipt({ hash: settle.transaction as Hex });
    expect(receipt.status).toBe("reverted");
    expect(receipt.gasUsed).toBeLessThanOrEqual(facilitator.config.maxSettleGas);
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(gasBefore - (await chain.nativeBalance(facilitator.service.address))).toBe(cost);
    expect(await chain.balanceOf(chain.simOnly, payTo)).toBe(0n);

    const after = (await (await fetch(`${facilitator.url}/metrics`)).json()) as typeof before;
    expect(after.settle.failed).toBe(before.settle.failed + 1);
    expect(after.gas.txCount).toBe(before.gas.txCount + 1);
    expect(BigInt(after.budget.globalSpentTodayWei) - BigInt(before.budget.globalSpentTodayWei)).toBe(cost);
  });

  it("an oversized body is refused in protocol shape (413) without being parsed", async () => {
    const requirements = reqs();
    const payload = await buildEip3009Payment(payer, requirements);
    const res = await postJson(`${facilitator.url}/verify`, wire(payload, { ...requirements, extra: { ...requirements.extra, pad: "x".repeat(70_000) } }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ isValid: false, invalidReason: "invalid_request" });
  });
});

describe("nothing secret leaves the process", () => {
  it("the RPC URL (which may carry a provider key) never appears in responses or logs, even when the RPC is down", async () => {
    const secret = "provider-key-9f8e7d6c";
    const dead = { url: `http://127.0.0.1:1/rpc/${secret}`, chainId: 31999 };
    const lines: string[] = [];
    const facilitatorWithDeadRpc = await startFacilitator(dead, ANVIL_KEYS[8], { LOG_LEVEL: "debug" }, {}, {
      logDestination: { write: (line: string) => void lines.push(line) },
    });
    try {
      const healthRes = await fetch(`${facilitatorWithDeadRpc.url}/health`);
      const healthText = await healthRes.text();
      expect(healthRes.status).toBe(200);
      expect(healthText).not.toContain(secret);
      const health = JSON.parse(healthText) as { status: string; networks: { rpcOk: boolean; error?: string }[] };
      expect(health.status).toBe("degraded");
      expect(health.networks[0]?.rpcOk).toBe(false);
      expect(health.networks[0]?.error).toContain("[url]");

      const requirements = requirementsFor({ network: `eip155:${dead.chainId}`, asset: chain.token, payTo, amount: PRICE, name: "T", version: "1" });
      const payload = await buildEip3009Payment(payer, requirements);
      const verify = await postJson(`${facilitatorWithDeadRpc.url}/verify`, wire(payload, requirements));
      expect(verify.status).toBe(503);
      expect(verify.body).toMatchObject({ isValid: false, invalidReason: "rpc_unavailable" });
      expect(Number(verify.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(JSON.stringify(verify.body)).not.toContain(secret);
      const settle = await postJson(`${facilitatorWithDeadRpc.url}/settle`, wire(payload, requirements));
      expect(settle.status).toBe(503);
      expect(settle.body).toMatchObject({ success: false, errorReason: "rpc_unavailable", transaction: "" });
      expect(JSON.stringify(settle.body)).not.toContain(secret);

      const error = (await new HTTPFacilitatorClient({ url: facilitatorWithDeadRpc.url })
        .verify(payload, requirements)
        .then(() => undefined, (e: unknown) => e)) as VerifyError;
      expect(error).toBeInstanceOf(VerifyError);
      expect(error.statusCode).toBe(503);
    } finally {
      await facilitatorWithDeadRpc.stop();
    }
    const log = lines.join("\n");
    expect(log).toContain("network probe failed");
    expect(log).toContain("RPC unavailable");
    expect(log).not.toContain(secret); // operator logs name the network and the host, never the URL path
    expect(log).toContain("http://127.0.0.1:1/…");
  });

  it("logs at debug level contain neither the signer key, nor payment signatures, nor API keys", async () => {
    const lines: string[] = [];
    const apiKey = "merchant-key-for-log-test-0123456789";
    const facilitatorKey = ANVIL_KEYS[5];
    const logged = await startFacilitator(
      anvil,
      facilitatorKey,
      { LOG_LEVEL: "debug", API_KEYS: JSON.stringify([{ name: "logtest", key: apiKey }]) },
      {},
      { logDestination: { write: (line: string) => void lines.push(line) } },
    );
    let signature = "";
    try {
      const requirements = reqs();
      const payload = await buildEip3009Payment(payer, requirements);
      signature = payload.payload["signature"] as string;
      const headers = { "X-API-Key": apiKey };
      expect((await postJson(`${logged.url}/verify`, wire(payload, requirements), headers)).status).toBe(200);
      const settled = await postJson(`${logged.url}/settle`, wire(payload, requirements), headers);
      expect(settled.status).toBe(200);
      expect(settled.body).toMatchObject({ success: true });
      // A refused call too (its log line carries the reason, never the payload).
      expect((await postJson(`${logged.url}/verify`, wire(payload, requirements), headers)).status).toBe(409);
      await fetch(`${logged.url}/health`);
    } finally {
      await logged.stop();
    }
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(3);
    expect(text).toContain('"op":"settle"');
    expect(text).toContain('"apiKey":"logtest"');
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(text).not.toContain(facilitatorKey.slice(2));
    expect(text).not.toContain(signature.slice(2));
    expect(text).not.toContain(apiKey);
    expect(text.toLowerCase()).not.toContain('signature":"0x');
  });
});

describe("health probe amplification", () => {
  /** Counts JSON-RPC requests on their way to anvil. */
  async function countingProxy(): Promise<{ url: string; count: () => number; reset: () => void; close: () => Promise<void> }> {
    let count = 0;
    const server = createServer((req, res) => {
      count += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        fetch(anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) })
          .then(async (upstream) => {
            res.writeHead(upstream.status, { "content-type": "application/json" });
            res.end(Buffer.from(await upstream.arrayBuffer()));
          })
          .catch(() => {
            res.writeHead(502);
            res.end();
          });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return {
      url: `http://127.0.0.1:${address.port}`,
      count: () => count,
      reset: () => void (count = 0),
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  it("GET /health is cached for HEALTH_CACHE_SECONDS, so polling it cannot multiply RPC calls", async () => {
    const proxy = await countingProxy();
    const endpoint = { url: proxy.url, chainId: anvil.chainId };
    try {
      const cached = await startFacilitator(endpoint, ANVIL_KEYS[8]); // default HEALTH_CACHE_SECONDS=10
      try {
        proxy.reset();
        await fetch(`${cached.url}/health`);
        const oneProbe = proxy.count();
        expect(oneProbe).toBeGreaterThan(0);
        await Promise.all(Array.from({ length: 20 }, () => fetch(`${cached.url}/health`)));
        expect(proxy.count()).toBe(oneProbe); // 20 more polls, zero more RPC calls
      } finally {
        await cached.stop();
      }

      const live = await startFacilitator(endpoint, ANVIL_KEYS[8], { HEALTH_CACHE_SECONDS: "0" });
      try {
        proxy.reset();
        for (let i = 0; i < 5; i++) await fetch(`${live.url}/health`);
        expect(proxy.count()).toBeGreaterThanOrEqual(5); // uncached: at least the balance read per poll
      } finally {
        await live.stop();
      }
    } finally {
      await proxy.close();
    }
  });
});
