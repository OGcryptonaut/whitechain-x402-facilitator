#!/usr/bin/env tsx
// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks (default) or deploys the x402 Permit2 proxies at their canonical CREATE2 addresses.
 *
 *   npm run permit2:check                       # status on Whitechain Sepolia (or RPC_URL)
 *   RPC_URL=https://rpc.testnet.whitechain.io \
 *   DEPLOYER_PRIVATE_KEY=0x… tsx scripts/deploy-permit2-proxies.ts --broadcast [--only exact|upto]
 *
 * Deployment needs only gas on the target chain (~300k gas per contract). The script refuses to
 * broadcast unless `--broadcast` is given, prints the exact addresses it will create first, and
 * asserts the vendored init codes hash to the canonical values before sending anything.
 *
 * On a public network, deploy with a throwaway key that holds just enough gas.
 */
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkDeployment, deployProxy, loadInitCode, PROXIES, type ProxyKind } from "./lib/permit2-proxies.js";

const args = process.argv.slice(2);
const broadcast = args.includes("--broadcast");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? (args[onlyIndex + 1] as ProxyKind | undefined) : undefined;
const rpcUrl = process.env.RPC_URL ?? "https://rpc.testnet.whitechain.io";

const publicClient = createPublicClient({ transport: http(rpcUrl) });
const status = await checkDeployment(publicClient);

console.log(`RPC:              ${rpcUrl}`);
console.log(`chain id:         ${status.chainId}`);
console.log(`CREATE2 deployer: ${status.deployer ? "present" : "MISSING"}`);
console.log(`Permit2:          ${status.permit2 ? "present" : "MISSING"}`);
for (const kind of ["exact", "upto"] as ProxyKind[]) {
  loadInitCode(kind); // throws if the vendored init code is not the canonical one
  const spec = PROXIES[kind];
  console.log(`${spec.contract.padEnd(22)} ${spec.address}  ${status[kind] ? "DEPLOYED" : "not deployed"}`);
}

if (!broadcast) {
  console.log("\nDry run. Pass --broadcast (with DEPLOYER_PRIVATE_KEY and RPC_URL) to deploy the missing proxies.");
  process.exit(0);
}

if (!status.deployer || !status.permit2) {
  console.error("Cannot deploy: the CREATE2 deployer and Permit2 must both exist on the target chain.");
  process.exit(1);
}
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("DEPLOYER_PRIVATE_KEY (0x-prefixed 32-byte hex) is required with --broadcast.");
  process.exit(1);
}
const account = privateKeyToAccount(key as Hex);
const chain = defineChain({
  id: status.chainId,
  name: `chain-${status.chainId}`,
  nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
console.log(`\ndeployer:         ${account.address}`);

for (const kind of ["exact", "upto"] as ProxyKind[]) {
  if (only && only !== kind) continue;
  if (status[kind]) {
    console.log(`${PROXIES[kind].contract}: already deployed, skipping`);
    continue;
  }
  const hash = await deployProxy(wallet, publicClient, kind);
  console.log(`${PROXIES[kind].contract}: deployed at ${PROXIES[kind].address} in ${hash}`);
}
console.log("done");
