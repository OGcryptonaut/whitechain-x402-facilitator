import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from "@x402/evm";
import { loadInitCode, PROXIES } from "../../scripts/lib/permit2-proxies.js";

describe("vendored x402 Permit2 proxy init codes", () => {
  it("hash to the canonical values and derive the addresses @x402/evm expects", () => {
    for (const kind of ["exact", "upto"] as const) {
      const initCode = loadInitCode(kind);
      expect(keccak256(initCode)).toBe(PROXIES[kind].initCodeHash);
      // Both init codes end with the ABI-encoded canonical Permit2 constructor argument.
      expect(initCode.toLowerCase().endsWith("000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3")).toBe(true);
    }
    expect(PROXIES.exact.address.toLowerCase()).toBe(x402ExactPermit2ProxyAddress.toLowerCase());
    expect(PROXIES.upto.address.toLowerCase()).toBe(x402UptoPermit2ProxyAddress.toLowerCase());
  });
});
