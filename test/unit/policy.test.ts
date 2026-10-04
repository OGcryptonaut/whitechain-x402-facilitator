import { describe, expect, it } from "vitest";
import pino from "pino";
import { ApiKeyRegistry } from "../../src/policy/apiKeys.js";
import { AuthorizationRegistry, authorizationKey, claimedPayer } from "../../src/policy/dedupe.js";
import { AccruingFeePolicy, createFeePolicy, NoFeePolicy } from "../../src/policy/fee.js";
import { parseApiKeys, sha256Hex } from "../../src/config.js";
import { REDACT_PATHS } from "../../src/logger.js";
import { parseFacilitatorRequest } from "../../src/schema.js";
import { Metrics } from "../../src/metrics.js";

describe("ApiKeyRegistry", () => {
  const registry = new ApiKeyRegistry(
    parseApiKeys(JSON.stringify([{ name: "a", key: "merchant-a-key-0123456789" }, { name: "b", keySha256: sha256Hex("merchant-b-key-0123456789") }])),
  );

  it("resolves plain and pre-hashed keys, rejects unknown and empty headers", () => {
    expect(registry.resolve("merchant-a-key-0123456789")?.name).toBe("a");
    expect(registry.resolve(" merchant-b-key-0123456789 ")?.name).toBe("b");
    expect(registry.resolve("merchant-c-key")).toBeUndefined();
    expect(registry.resolve(undefined)).toBeUndefined();
    expect(registry.resolve("")).toBeUndefined();
    expect(registry.size).toBe(2);
  });

  it("refuses duplicate keys", () => {
    expect(
      () => new ApiKeyRegistry(parseApiKeys(JSON.stringify([{ name: "a", key: "same-key-0123456789abcdef" }, { name: "b", key: "same-key-0123456789abcdef" }]))),
    ).toThrow(/duplicate/);
  });
});

describe("AuthorizationRegistry / dedupe keys", () => {
  it("derives keys from EIP-3009 and Permit2 payloads and the claimed payer", () => {
    const eip3009 = { authorization: { from: "0xAbC0000000000000000000000000000000000001", nonce: "0xAA" }, signature: "0x" };
    expect(authorizationKey("eip155:1874", "0xTOKEN", eip3009)).toBe("eip155:1874|0xtoken|0xabc0000000000000000000000000000000000001|0xaa");
    const permit2 = { permit2Authorization: { from: "0xAbC0000000000000000000000000000000000001", nonce: "123" }, signature: "0x" };
    expect(authorizationKey("eip155:1874", "0xTOKEN", permit2)).toBe("eip155:1874|permit2|0xabc0000000000000000000000000000000000001|123");
    expect(authorizationKey("eip155:1874", "0xTOKEN", { foo: 1 })).toBeUndefined();
    expect(claimedPayer(eip3009)).toBe("0xAbC0000000000000000000000000000000000001");
    expect(claimedPayer({ authorization: { from: "nope" } })).toBeUndefined();
    expect(claimedPayer(undefined)).toBeUndefined();
  });

  it("tracks in-flight and settled states with TTL and bounded size", () => {
    let now = 0;
    const registry = new AuthorizationRegistry({ settledTtlMs: 1000, maxEntries: 2, now: () => now });
    expect(registry.begin("k1")).toBe(true);
    expect(registry.begin("k1")).toBe(false);
    expect(registry.lookup("k1")).toEqual({ kind: "in-flight" });
    registry.end("k1");
    expect(registry.lookup("k1")).toBeUndefined();
    expect(registry.begin("k1")).toBe(true);
    registry.settled("k1", "0xtx");
    expect(registry.begin("k1")).toBe(false);
    registry.end("k1"); // end() never clears a settled mark
    expect(registry.lookup("k1")).toMatchObject({ kind: "settled", transaction: "0xtx" });
    now = 1001;
    expect(registry.lookup("k1")).toBeUndefined();
    registry.settled("a", "0x1");
    registry.settled("b", "0x2");
    registry.settled("c", "0x3");
    expect(registry.size()).toBeLessThanOrEqual(2);
  });
});

describe("fee policy", () => {
  const ctx = { network: "eip155:1874", asset: "0xToken", amount: 1_000_000n, payTo: "0xMerchant", payer: "0xPayer", apiKeyName: undefined };

  it("is off by default and sponsors everything", () => {
    const policy = createFeePolicy({ mode: "off", bps: 0, flatAtomic: 0n });
    expect(policy).toBeInstanceOf(NoFeePolicy);
    expect(policy.quote(ctx)).toEqual({ sponsor: true, feeAtomic: 0n });
    expect(policy.snapshot()).toEqual({ mode: "off" });
  });

  it("accrues flat + bps fees per payTo or API key", () => {
    const policy = createFeePolicy({ mode: "accrue", bps: 50, flatAtomic: 10n }) as AccruingFeePolicy;
    const quote = policy.quote(ctx);
    expect(quote).toEqual({ sponsor: true, feeAtomic: 10n + 5_000n });
    policy.onSettled(ctx, quote);
    policy.onSettled({ ...ctx, apiKeyName: "merchant-a" }, quote);
    const snap = policy.snapshot() as { accrued: Record<string, { feeAtomic: string; settles: number }> };
    expect(snap.accrued["payto:0xmerchant|eip155:1874|0xtoken"]).toEqual({ network: "eip155:1874", asset: "0xToken", feeAtomic: "5010", settles: 1 });
    expect(snap.accrued["apikey:merchant-a|eip155:1874|0xtoken"]?.settles).toBe(1);
  });
});

describe("request schema", () => {
  const requirements = {
    scheme: "exact",
    network: "eip155:1874",
    asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    amount: "10000",
    payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    maxTimeoutSeconds: 60,
    extra: { name: "T", version: "1" },
  };

  const authorization = {
    from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: "0",
    validBefore: "1791140000",
    nonce: `0x${"00".repeat(31)}01`,
  };

  it("accepts a well-formed verify/settle body", () => {
    const parsed = parseFacilitatorRequest({
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: { authorization, signature: `0x${"ab".repeat(65)}` } },
      paymentRequirements: requirements,
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects an authorization without the EIP-3009 fields the scheme needs", () => {
    const parsed = parseFacilitatorRequest({
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: { authorization: {}, signature: "0x" } },
      paymentRequirements: requirements,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/authorization\.from/);
  });

  it("rejects malformed bodies with a readable message", () => {
    const parsed = parseFacilitatorRequest({ x402Version: 2, paymentPayload: {}, paymentRequirements: { ...requirements, amount: "1.5" } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/amount|accepted|payload/);
    expect(parseFacilitatorRequest(null).ok).toBe(false);
    expect(parseFacilitatorRequest("string").ok).toBe(false);
  });
});

describe("logger redaction", () => {
  it("never writes signatures, API keys or private keys", () => {
    const lines: string[] = [];
    const logger = pino({ level: "info", redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, { write: (line: string) => void lines.push(line) });
    logger.info({ paymentPayload: { payload: { signature: "0xdeadbeefsig", authorization: { from: "0x1" } } } }, "verify");
    logger.info({ payload: { signature: "0xsig2" }, signature: "0xsig3", extensions: { eip2612GasSponsoring: { info: { signature: "0xsig4" } } } }, "x");
    logger.info({ req: { headers: { "x-api-key": "supersecret", authorization: "Bearer tok" } } }, "y");
    logger.info({ FACILITATOR_PRIVATE_KEY: "0xkey1", config: { privateKey: "0xkey2" } }, "z");
    const out = lines.join("\n");
    for (const secret of ["0xdeadbeefsig", "0xsig2", "0xsig3", "0xsig4", "supersecret", "Bearer tok", "0xkey1", "0xkey2"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
    expect(out).toContain('"from":"0x1"');
  });
});

describe("Metrics", () => {
  it("snapshots counters, reasons and gas", () => {
    const m = new Metrics();
    m.inc("verify.total", 2);
    m.inc("verify.invalid");
    m.reason("verify", "invalid_exact_evm_signature");
    m.reason("verify", undefined);
    m.addGas("eip155:1874", 5n);
    m.addGas("eip155:1874", 7n);
    m.addSettledAmount("eip155:1874", "0xABC", 10n);
    const snap = m.snapshot() as { verify: { total: number; invalid: number; byReason: Record<string, number> }; gas: { spentWei: Record<string, string> }; settle: { settledAmountAtomic: Record<string, string> } };
    expect(snap.verify).toMatchObject({ total: 2, invalid: 1, byReason: { invalid_exact_evm_signature: 1, unknown: 1 } });
    expect(snap.gas.spentWei).toEqual({ "eip155:1874": "12", total: "12" });
    expect(snap.settle.settledAmountAtomic["eip155:1874|0xabc"]).toBe("10");
  });
});
