// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0
//
// An agent that pays an x402-protected API on Whitechain. It wraps `fetch` with
// @x402/fetch: on a 402 response it signs an EIP-3009 authorization for the
// exact amount asked and retries. The agent needs no gas; the facilitator the
// merchant uses submits the transfer.

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Network } from "@x402/fetch";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const privateKey = required("AGENT_PRIVATE_KEY");
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error("AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key (use a throwaway testnet key).");
  process.exit(1);
}
const asset = required("ASSET_ADDRESS");
const resourceUrl = process.env.RESOURCE_URL?.trim() || "http://localhost:4021/weather";
const method = (process.env.RESOURCE_METHOD?.trim() || "GET").toUpperCase();
const requestBody = process.env.RESOURCE_BODY?.trim();
const network = (process.env.NETWORK?.trim() || "eip155:1874") as Network;
// Hard cap per payment, in the token's smallest unit. 6 decimals: 100000 = 0.10.
const maxAmountAtomic = process.env.MAX_AMOUNT_ATOMIC?.trim() || "100000";
const explorerUrl = (process.env.EXPLORER_URL?.trim() || "https://explorer.testnet.whitechain.io").replace(/\/+$/, "");

const account = privateKeyToAccount(privateKey as `0x${string}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  // Register the Whitechain network only: the agent will not pay on any other chain.
  schemes: [{ network, client: new ExactEvmScheme(account) }],
  // The x402 client refuses tokens it does not know. Whitechain tokens are not in
  // the SDK's default list, so allow this one token explicitly, with a cap.
  spendControls: {
    allowedAssets: [{ network, asset, maxAmountPerPayment: maxAmountAtomic }],
  },
});

console.log(`agent ${account.address} -> ${method} ${resourceUrl}`);

const response = await fetchWithPayment(resourceUrl, {
  method,
  ...(requestBody ? { body: requestBody, headers: { "Content-Type": "application/json" } } : {}),
});

const text = await response.text();
console.log(`status: ${response.status}`);
console.log(`body:   ${text}`);

const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
if (paymentResponse) {
  const settlement = decodePaymentResponseHeader(paymentResponse);
  console.log(`paid:   success=${settlement.success} payer=${settlement.payer ?? "?"} network=${settlement.network}`);
  if (settlement.transaction) {
    console.log(`tx:     ${explorerUrl}/tx/${settlement.transaction}`);
  }
} else {
  console.log("paid:   no PAYMENT-RESPONSE header (the endpoint was free, or the payment was not settled)");
}

if (!response.ok) {
  process.exit(1);
}
