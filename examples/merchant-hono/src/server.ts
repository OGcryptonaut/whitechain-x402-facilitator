// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0
//
// A Hono API with one paid endpoint. Payment is x402 `exact` on Whitechain,
// verified and settled by a Whitechain x402 Facilitator. The buyer pays the
// merchant address (PAY_TO) directly; this server never holds a key.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Network } from "@x402/core/types";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const facilitatorUrl = required("FACILITATOR_URL");
const payTo = required("PAY_TO");
const asset = required("ASSET_ADDRESS");
// The token's EIP-712 domain. The buyer signs an EIP-3009 authorization over
// this domain, so both values must match what the token contract reports.
const assetName = process.env.ASSET_NAME?.trim() || "Inferit Test Credit";
const assetVersion = process.env.ASSET_VERSION?.trim() || "1";
// Price in the token's smallest unit. ITC and USDC.e have 6 decimals: 2500 = 0.0025.
const priceAtomic = process.env.PRICE_ATOMIC?.trim() || "2500";
const network = (process.env.NETWORK?.trim() || "eip155:1874") as Network;
const apiKey = process.env.FACILITATOR_API_KEY?.trim();
const port = Number(process.env.PORT ?? 4022);

// The facilitator client. The API key is optional: the public testnet
// facilitator is free without one, a key only raises the rate limits.
const facilitator = new HTTPFacilitatorClient({
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

const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

const app = new Hono();

app.use(
  paymentMiddleware(
    {
      "POST /summarize": {
        accepts: {
          scheme: "exact",
          network,
          payTo,
          // Whitechain has no built-in "$" default asset in the x402 SDK, so the
          // price names the token explicitly: address, atomic amount, EIP-712 domain.
          price: {
            asset,
            amount: priceAtomic,
            extra: { name: assetName, version: assetVersion },
          },
          maxTimeoutSeconds: 120,
        },
        description: "Summarise a block of text, paid per request on Whitechain",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// Free: tells a caller what this server sells.
app.get("/", (c) =>
  c.json({
    service: "whitechain-x402-example-merchant-hono",
    paid: { "POST /summarize": { network, asset, amount: priceAtomic, payTo } },
    facilitator: facilitatorUrl,
  }),
);

// Paid: the handler only runs after the facilitator has verified the payment.
// The middleware settles on chain after the handler responds successfully.
app.post("/summarize", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return c.json({
    summary: sentences[0] ?? "",
    sentences: sentences.length,
    characters: text.length,
  });
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`merchant-hono listening on http://localhost:${info.port}`);
  console.log(`  paid:  POST /summarize  (${priceAtomic} atomic units of ${asset} on ${network})`);
  console.log(`  payTo: ${payTo}`);
  console.log(`  facilitator: ${facilitatorUrl}`);
});
