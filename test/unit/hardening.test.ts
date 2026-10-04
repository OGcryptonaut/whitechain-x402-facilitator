// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/** Regression tests for the adversarial review (see VERIFICATION.md). */
import { describe, expect, it } from "vitest";
import { loadConfig, parseNetworks, redactUrl } from "../../src/config.js";
import { errorMessage, publicErrorMessage, Reasons } from "../../src/errors.js";
import { authorizationKey, claimedPayer, normalizeNonce, payloadKind } from "../../src/policy/dedupe.js";
import { parseFacilitatorRequest } from "../../src/schema.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SANCTIONED = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const NONCE = `0x${"ab".repeat(32)}`;

const requirements = {
  scheme: "exact",
  network: "eip155:1874",
  asset: TOKEN,
  amount: "10000",
  payTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  maxTimeoutSeconds: 60,
  extra: { name: "T", version: "1" },
};
const authorization = { from: PAYER, to: requirements.payTo, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: NONCE };
const permit2Authorization = {
  from: SANCTIONED,
  spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
  nonce: "1",
  deadline: "9999999999",
  permitted: { token: TOKEN, amount: "10000" },
  witness: { to: requirements.payTo, validAfter: "0" },
};
const body = (payload: Record<string, unknown>) => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted: requirements, payload },
  paymentRequirements: requirements,
});

describe("payload type routing mirrors @x402/evm", () => {
  it("a payload with both authorization and permit2Authorization is refused by the schema", () => {
    const parsed = parseFacilitatorRequest(body({ signature: "0x00", authorization, permit2Authorization }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/not both/);
  });

  it("a payload with neither is refused by the schema", () => {
    const parsed = parseFacilitatorRequest(body({ signature: "0x00" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/authorization/);
  });

  it("screening helpers pick the same payer the SDK will settle for, even with a decoy authorization", () => {
    // The SDK's isPermit2Payload() is `"permit2Authorization" in payload`; a decoy `authorization`
    // must not be what the denylist, rate limits or dedupe look at.
    const decoy = { signature: "0x00", authorization, permit2Authorization };
    expect(payloadKind(decoy)).toBe("permit2");
    expect(claimedPayer(decoy)).toBe(SANCTIONED);
    expect(authorizationKey("eip155:1874", TOKEN, decoy)).toBe(`eip155:1874|permit2|${SANCTIONED.toLowerCase()}|1`);
    expect(payloadKind({ signature: "0x00", authorization })).toBe("eip3009");
    expect(claimedPayer({ signature: "0x00", authorization })).toBe(PAYER);
    expect(payloadKind({ signature: "0x00" })).toBe("unknown");
    expect(claimedPayer({ signature: "0x00" })).toBeUndefined();
  });

  it("dedupe keys are canonical across nonce spellings", () => {
    expect(normalizeNonce("permit2", "01")).toBe("1");
    expect(normalizeNonce("permit2", "0x1")).toBe("1");
    expect(normalizeNonce("permit2", "1")).toBe("1");
    expect(normalizeNonce("eip3009", "0xAB")).toBe("0xab");
    const k = (nonce: string) => authorizationKey("eip155:1", TOKEN, { permit2Authorization: { ...permit2Authorization, nonce } });
    expect(k("01")).toBe(k("0x1"));
    expect(k("1")).toBe(k("0x01"));
    expect(k("2")).not.toBe(k("1"));
  });

  it("malformed scheme fields are a 400, not a crash inside the SDK", () => {
    const bad = (patch: Partial<typeof authorization>) => parseFacilitatorRequest(body({ signature: "0x00", authorization: { ...authorization, ...patch } }));
    for (const [patch, expected] of [
      [{ from: "0Xabc" }, /authorization\.from/],
      [{ to: "not-an-address" }, /authorization\.to/],
      [{ value: "1.5" }, /authorization\.value/],
      [{ nonce: "0x01" }, /authorization\.nonce/],
      [{ validBefore: "-1" }, /authorization\.validBefore/],
    ] as const) {
      const parsed = bad(patch);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(expected);
    }
    expect(parseFacilitatorRequest(body({ signature: "zz", authorization })).ok).toBe(false);
    expect(parseFacilitatorRequest(body({ signature: "0x00", authorization })).ok).toBe(true);
    expect(parseFacilitatorRequest(body({ signature: "0x00", permit2Authorization })).ok).toBe(true);
    // Permit2 payloads for `upto` carry extra witness fields; unknown fields pass through.
    expect(
      parseFacilitatorRequest(
        body({
          signature: "0x00",
          permit2Authorization: { ...permit2Authorization, witness: { ...permit2Authorization.witness, facilitator: PAYER, extra: "x" } },
        }),
      ).ok,
    ).toBe(true);
    expect(parseFacilitatorRequest(body({ signature: "0x00", permit2Authorization: { ...permit2Authorization, from: "0x1" } })).ok).toBe(false);
  });
});

describe("public error messages", () => {
  it("strip URLs (provider keys live in RPC paths), collapse whitespace and bound the length", () => {
    const viemLike = new Error(
      'HTTP request failed.\n\nURL: https://rpc.example.com/v2/sk_live_SECRET123\nRequest body: {"method":"eth_call"}\n\nDetails: fetch failed\nVersion: viem@2.57.2',
    );
    const message = publicErrorMessage(viemLike);
    expect(message).not.toContain("SECRET123");
    expect(message).not.toContain("rpc.example.com");
    expect(message).toContain("[url]");
    expect(message).not.toMatch(/\n/);
    expect(errorMessage(viemLike)).toContain("SECRET123"); // operator logs keep the full text
    expect(publicErrorMessage("x".repeat(1000)).length).toBeLessThanOrEqual(240);
    expect(publicErrorMessage("x".repeat(1000)).endsWith("…")).toBe(true);
    expect(publicErrorMessage("ws://user:pw@host:8546/path and http://127.0.0.1:8545/key")).toBe("[url] and [url]");
    expect(publicErrorMessage(new Error("plain"))).toBe("plain");
  });

  it("has a dedicated reason for an unreachable RPC", () => {
    expect(Reasons.rpcUnavailable).toBe("rpc_unavailable");
  });
});

describe("configuration hardening", () => {
  it("only accepts http(s) RPC and explorer URLs", () => {
    expect(() => parseNetworks('[{"id":"eip155:1","rpc":"ftp://rpc.example/x"}]')).toThrow(/http/);
    expect(() => parseNetworks('[{"id":"eip155:1","rpc":"file:///etc/passwd"}]')).toThrow(/http/);
    expect(() => parseNetworks('[{"id":"eip155:1","rpc":"http://127.0.0.1:8545","explorer":"javascript:alert(1)"}]')).toThrow();
    expect(parseNetworks('[{"id":"eip155:1","rpc":"https://rpc.example/v2/key"}]')[0]?.rpcUrl).toBe("https://rpc.example/v2/key");
  });

  it("redacts RPC URLs down to their origin for logs and /health", () => {
    expect(redactUrl("https://rpc.example.com/v2/sk_live_SECRET")).toBe("https://rpc.example.com/…");
    expect(redactUrl("https://user:password@rpc.example.com:8545/")).toBe("https://rpc.example.com:8545");
    expect(redactUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
    expect(redactUrl("not a url")).toBe("[invalid url]");
    const described = JSON.stringify(
      loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, NETWORKS: '[{"id":"eip155:1","rpc":"https://rpc.example.com/v2/sk_live_SECRET"}]' }).networks,
    );
    expect(described).toContain("sk_live_SECRET"); // the config itself keeps the real URL for viem
  });

  it("parses the facilitator-wide rate limit (0 disables)", () => {
    expect(loadConfig({ FACILITATOR_PRIVATE_KEY: KEY }).rateLimit.globalPerWindow).toBe(1200);
    expect(loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, RATE_LIMIT_GLOBAL_PER_WINDOW: "0" }).rateLimit.globalPerWindow).toBe(0);
    expect(() => loadConfig({ FACILITATOR_PRIVATE_KEY: KEY, RATE_LIMIT_GLOBAL_PER_WINDOW: "-1" })).toThrow();
  });
});
