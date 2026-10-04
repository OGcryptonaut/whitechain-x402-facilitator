#!/usr/bin/env tsx
// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live smoke test against a running facilitator on Whitechain Sepolia (not part of `npm test`).
 *
 * It starts a throwaway merchant (official @x402/express middleware + HTTPFacilitatorClient) on
 * localhost, pays it with the official @x402/fetch client, and checks that the token moved and the
 * payer paid no gas. Then it replays the same payment and expects a refusal.
 *
 *   FACILITATOR_URL=https://facilitator.example \
 *   PAYER_PRIVATE_KEY=0x…   (holds the test token; needs NO gas) \
 *   TOKEN_ADDRESS=0x…       (EIP-3009 token, e.g. Inferit Test Credit) \
 *   npm run smoke:sepolia
 *
 * Optional: RPC_URL (default Whitechain Sepolia), NETWORK (eip155:1874), PAY_TO (default: payer),
 * AMOUNT (atomic, default 10000), TOKEN_NAME / TOKEN_VERSION (default: read from the contract),
 * EXPLORER_URL, FACILITATOR_API_KEY.
 */
import { createServer } from "node:http";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { createPublicClient, defineChain, formatUnits, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

const facilitatorUrl = need("FACILITATOR_URL").replace(/\/+$/, "");
const payerKey = need("PAYER_PRIVATE_KEY") as Hex;
const token = need("TOKEN_ADDRESS") as Address;
const rpcUrl = process.env.RPC_URL ?? "https://rpc.testnet.whitechain.io";
const network = (process.env.NETWORK ?? "eip155:1874") as Network;
const chainId = Number(network.split(":")[1]);
const explorer = (process.env.EXPLORER_URL ?? "https://explorer.testnet.whitechain.io").replace(/\/+$/, "");
const amount = process.env.AMOUNT ?? "10000";
const apiKey = process.env.FACILITATOR_API_KEY;

const payer = privateKeyToAccount(payerKey);
const payTo = (process.env.PAY_TO ?? payer.address) as Address;
const chain = defineChain({
  id: chainId,
  name: network,
  nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

const erc20 = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const read = <T>(functionName: "name" | "version" | "decimals" | "balanceOf", args?: readonly unknown[]) =>
  publicClient.readContract({ address: token, abi: erc20, functionName, args: args as never }) as Promise<T>;

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

console.log(`facilitator: ${facilitatorUrl}`);
console.log(`network:     ${network} via ${rpcUrl}`);
console.log(`token:       ${token}`);
console.log(`payer:       ${payer.address}`);
console.log(`payTo:       ${payTo}`);

// 1. facilitator discovery
const facilitatorClient = new HTTPFacilitatorClient({
  url: facilitatorUrl,
  ...(apiKey
    ? {
        createAuthHeaders: async () => {
          const headers = { "X-API-Key": apiKey };
          return { verify: headers, settle: headers, supported: headers };
        },
      }
    : {}),
});
const supported = await facilitatorClient.getSupported();
check(
  supported.kinds.some((k) => k.scheme === "exact" && k.network === network && k.x402Version === 2),
  "GET /supported advertises exact on the network",
  JSON.stringify(supported.kinds),
);
const health = (await (await fetch(`${facilitatorUrl}/health`)).json()) as {
  status: string;
  networks: { network: string; gasBalance?: string; settleRunway?: number | null; rpcOk: boolean }[];
};
const net = health.networks.find((n) => n.network === network);
check(!!net?.rpcOk, "GET /health reports the network RPC as reachable", `status=${health.status} gas=${net?.gasBalance} runway=${net?.settleRunway}`);

// 2. token metadata & balances
const [tokenName, tokenVersion, decimals] = await Promise.all([
  process.env.TOKEN_NAME ? Promise.resolve(process.env.TOKEN_NAME) : read<string>("name"),
  process.env.TOKEN_VERSION ? Promise.resolve(process.env.TOKEN_VERSION) : read<string>("version").catch(() => "1"),
  read<number>("decimals"),
]);
const payerBefore = await read<bigint>("balanceOf", [payer.address]);
const payToBefore = await read<bigint>("balanceOf", [payTo]);
const payerGasBefore = await publicClient.getBalance({ address: payer.address });
console.log(`token name/version: "${tokenName}" / "${tokenVersion}", decimals ${decimals}`);
console.log(`payer balance: ${formatUnits(payerBefore, decimals)}  payTo balance: ${formatUnits(payToBefore, decimals)}`);
if (payerBefore < BigInt(amount)) {
  console.error("payer does not hold enough tokens for the test amount");
  process.exit(2);
}

// 3. throwaway merchant with the official middleware
const resourceServer = new x402ResourceServer(facilitatorClient).register(network, new ExactEvmServerScheme());
const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /smoke": {
        accepts: {
          scheme: "exact",
          network,
          payTo,
          price: { asset: token, amount, extra: { name: tokenName, version: tokenVersion } },
          maxTimeoutSeconds: 300,
        },
        description: "whitechain-x402-facilitator smoke test",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);
app.get("/smoke", (_req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const address = server.address();
const merchantUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

try {
  // 4. pay with the official client, capturing the payment header for the replay check
  let paymentHeader: string | undefined;
  const spyFetch: typeof fetch = async (input, init) => {
    const headers = typeof input === "object" && input !== null && "headers" in input ? (input as Request).headers : new Headers(init?.headers);
    paymentHeader = headers.get("PAYMENT-SIGNATURE") ?? paymentHeader;
    return fetch(input, init);
  };
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(spyFetch, {
    schemes: [{ network, client: new ExactEvmClientScheme(payer) }],
    spendControls: { allowedAssets: [{ network, asset: token, maxAmountPerPayment: amount }] },
  });

  const started = Date.now();
  const res = await fetchWithPayment(`${merchantUrl}/smoke`);
  const elapsed = Date.now() - started;
  const body = await res.text();
  check(res.status === 200, "paid request returned 200", `${elapsed}ms body=${body.slice(0, 80)}`);
  const header = res.headers.get("PAYMENT-RESPONSE");
  check(!!header, "PAYMENT-RESPONSE header present");
  if (header) {
    const settlement = decodePaymentResponseHeader(header);
    check(settlement.success === true, "settlement success", `reason=${settlement.errorReason ?? "-"}`);
    if (settlement.transaction) console.log(`tx: ${explorer}/tx/${settlement.transaction}`);
    if (settlement.transaction) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: settlement.transaction as Hex, timeout: 120_000 });
      check(receipt.status === "success", "settlement tx mined successfully", `gasUsed=${receipt.gasUsed} from=${receipt.from}`);
    }
  }
  const payerAfter = await read<bigint>("balanceOf", [payer.address]);
  const payToAfter = await read<bigint>("balanceOf", [payTo]);
  const payerGasAfter = await publicClient.getBalance({ address: payer.address });
  if (payTo.toLowerCase() === payer.address.toLowerCase()) {
    check(payerAfter === payerBefore, "self-payment: token balance unchanged", `${payerBefore} -> ${payerAfter}`);
  } else {
    check(payerAfter === payerBefore - BigInt(amount), "payer token balance decreased by amount", `${payerBefore} -> ${payerAfter}`);
    check(payToAfter === payToBefore + BigInt(amount), "payTo token balance increased by amount", `${payToBefore} -> ${payToAfter}`);
  }
  check(payerGasAfter === payerGasBefore, "payer paid no gas", `${payerGasBefore} -> ${payerGasAfter}`);

  // 5. replay must be refused
  if (paymentHeader) {
    const replay = await fetch(`${merchantUrl}/smoke`, { headers: { "PAYMENT-SIGNATURE": paymentHeader } });
    const required = replay.headers.get("PAYMENT-REQUIRED");
    const reason = required ? (JSON.parse(Buffer.from(required, "base64").toString("utf8")) as { error?: string }).error : undefined;
    check(replay.status === 402, "replayed payment header refused with 402", `error=${reason}`);
  }
} finally {
  server.close();
}

console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
