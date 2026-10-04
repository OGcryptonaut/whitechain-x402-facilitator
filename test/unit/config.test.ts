import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig, parseApiKeys, parseNativeBudget, parseNetworks, sha256Hex } from "../../src/config.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("loadConfig", () => {
  it("defaults to Whitechain Sepolia with sane limits", () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: KEY });
    expect(c.networks).toHaveLength(1);
    expect(c.networks[0]).toMatchObject({
      id: "eip155:1874",
      chainId: 1874,
      rpcUrl: "https://rpc.testnet.whitechain.io",
      explorerUrl: "https://explorer.testnet.whitechain.io",
      nativeSymbol: "WBT",
      testnet: true,
    });
    expect([...c.schemes]).toEqual(["exact", "upto"]);
    expect(c.port).toBe(8402);
    expect(c.gasBudget.globalDailyWei).toBe(10n ** 18n);
    expect(c.gasBudget.perPayToDailyWei).toBe(10n ** 17n);
    expect(c.maxSettleGas).toBe(300_000n);
    expect(c.fee.mode).toBe("off");
    expect(c.requireApiKey).toBe(false);
  });

  it("never exposes the private key through enumeration or JSON", () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: KEY });
    expect(Object.keys(c)).not.toContain("privateKey");
    const json = JSON.stringify(c, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toContain(KEY.slice(4));
    expect(JSON.stringify(describeConfig(c))).not.toContain(KEY.slice(4));
    expect(c.privateKey).toBe(KEY);
  });

  it("rejects a missing or malformed signer key", () => {
    expect(() => loadConfig({})).toThrow(/FACILITATOR_PRIVATE_KEY/);
    expect(() => loadConfig({ FACILITATOR_PRIVATE_KEY: "0x1234" })).toThrow(/FACILITATOR_PRIVATE_KEY/);
  });

  it("parses TRUST_PROXY as boolean or hop count", () => {
    expect(loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ FACILITATOR_PRIVATE_KEY: KEY }).trustProxy).toBe(false);
  });

  it("requires exact and validates SCHEMES", () => {
    expect(() => loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, SCHEMES: "upto" })).toThrow(/exact/);
    expect(() => loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, SCHEMES: "exact,bogus" })).toThrow(/bogus/);
    expect([...loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, SCHEMES: "exact" }).schemes]).toEqual(["exact"]);
  });

  it("parses the fee hook", () => {
    const c = loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, FEE_MODE: "accrue", FEE_BPS: "25", FEE_FLAT_ATOMIC: "100" });
    expect(c.fee).toEqual({ mode: "accrue", bps: 25, flatAtomic: 100n });
  });
});

describe("parseNetworks", () => {
  it("accepts rpc/explorer aliases and lower-cases the asset allowlist", () => {
    const [n] = parseNetworks(
      JSON.stringify([
        {
          id: "eip155:31337",
          rpcUrl: "http://127.0.0.1:8545",
          explorerUrl: "https://explorer.example/",
          assets: ["0x5FbDB2315678afecb367f032d93F642f64180aa3"],
        },
      ]),
    );
    expect(n).toMatchObject({ id: "eip155:31337", chainId: 31337, rpcUrl: "http://127.0.0.1:8545", explorerUrl: "https://explorer.example" });
    expect(n?.assets?.has("0x5fbdb2315678afecb367f032d93f642f64180aa3")).toBe(true);
    expect(n?.name).toBe("eip155:31337");
  });

  it("rejects duplicates, bad ids and missing rpc", () => {
    expect(() => parseNetworks('[{"id":"eip155:1","rpc":"http://a"},{"id":"eip155:1","rpc":"http://b"}]')).toThrow(/duplicate/);
    expect(() => parseNetworks('[{"id":"base-sepolia","rpc":"http://a"}]')).toThrow();
    expect(() => parseNetworks('[{"id":"eip155:1"}]')).toThrow(/rpc/);
    expect(() => parseNetworks("[]")).toThrow();
  });

  it("accepts a single object", () => {
    expect(parseNetworks('{"id":"eip155:5","rpc":"http://a"}')).toHaveLength(1);
  });
});

describe("parseNativeBudget", () => {
  it("parses decimal native amounts to wei, with unlimited and kill-switch forms", () => {
    expect(parseNativeBudget("1")).toBe(10n ** 18n);
    expect(parseNativeBudget("0.25")).toBe(25n * 10n ** 16n);
    expect(parseNativeBudget("0")).toBe(0n);
    expect(parseNativeBudget("unlimited")).toBeNull();
    expect(parseNativeBudget("off")).toBeNull();
    expect(() => parseNativeBudget("1e18")).toThrow();
    expect(() => parseNativeBudget("-1")).toThrow();
  });
});

describe("parseApiKeys", () => {
  it("hashes plain keys and accepts pre-hashed keys", () => {
    const keys = parseApiKeys(
      JSON.stringify([
        { name: "a", key: "plain-key-0123456789abcdef", dailyGasBudget: "0.5", payTo: ["0x5FbDB2315678afecb367f032d93F642f64180aa3"] },
        { name: "b", keySha256: "0x" + sha256Hex("other"), rateLimitMultiplier: 3 },
      ]),
    );
    expect(keys[0]).toMatchObject({ name: "a", digest: sha256Hex("plain-key-0123456789abcdef"), rateLimitMultiplier: 10, dailyGasBudgetWei: 5n * 10n ** 17n });
    expect(keys[0]?.payTo?.has("0x5fbdb2315678afecb367f032d93f642f64180aa3")).toBe(true);
    expect(keys[1]).toMatchObject({ name: "b", digest: sha256Hex("other"), rateLimitMultiplier: 3, dailyGasBudgetWei: undefined });
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(() => parseApiKeys('[{"name":"x"}]')).toThrow(/key/);
    expect(() => parseApiKeys('[{"name":"x","key":"short"}]')).toThrow();
  });
});
