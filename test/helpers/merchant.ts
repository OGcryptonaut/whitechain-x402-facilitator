// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resource servers built from the OFFICIAL x402 middlewares (@x402/express, @x402/hono), pointed
 * at the facilitator under test through @x402/core's HTTPFacilitatorClient — exactly how a
 * merchant would integrate. Nothing here is modified or mocked.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware as expressPaymentMiddleware } from "@x402/express";
import { paymentMiddleware as honoPaymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import type { PaymentOption, RoutesConfig } from "@x402/core/http";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme as UptoEvmServerScheme } from "@x402/evm/upto/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import type { Address } from "viem";

export interface MerchantOptions {
  facilitatorUrl: string;
  network: Network;
  payTo: Address;
  asset: Address;
  assetName: string;
  assetVersion: string;
  /** Atomic units. */
  amount: string;
  maxTimeoutSeconds?: number;
  /** "eip3009" (default) or "permit2". */
  assetTransferMethod?: "eip3009" | "permit2";
  /** Register the `upto` scheme as well and expose GET /upto. */
  upto?: boolean;
  /** Advertise EIP-2612 gas sponsoring (gasless Permit2 approval) on the paid route. */
  eip2612?: boolean;
  apiKey?: string;
}

export interface RunningMerchant {
  url: string;
  stop(): Promise<void>;
}

export function facilitatorClientFor(opts: Pick<MerchantOptions, "facilitatorUrl" | "apiKey">): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({
    url: opts.facilitatorUrl,
    timeoutMs: 60_000,
    ...(opts.apiKey
      ? {
          createAuthHeaders: async () => {
            const headers = { "X-API-Key": opts.apiKey as string };
            return { verify: headers, settle: headers, supported: headers };
          },
        }
      : {}),
  });
}

function routesFor(opts: MerchantOptions): RoutesConfig {
  const extra: Record<string, unknown> = { name: opts.assetName, version: opts.assetVersion };
  if (opts.assetTransferMethod === "permit2") extra["assetTransferMethod"] = "permit2";
  const exact: PaymentOption = {
    scheme: "exact",
    network: opts.network,
    payTo: opts.payTo,
    price: { asset: opts.asset, amount: opts.amount, extra },
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
  };
  const routes: RoutesConfig = {
    "GET /paid": {
      accepts: exact,
      description: "A paid resource",
      mimeType: "application/json",
      ...(opts.eip2612 ? { extensions: { ...declareEip2612GasSponsoringExtension() } } : {}),
    },
  };
  if (opts.upto) {
    routes["GET /upto"] = {
      accepts: {
        scheme: "upto",
        network: opts.network,
        payTo: opts.payTo,
        price: { asset: opts.asset, amount: opts.amount, extra: { name: opts.assetName, version: opts.assetVersion } },
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
      },
      description: "A metered resource (upto)",
      mimeType: "application/json",
    };
  }
  return routes;
}

function resourceServerFor(opts: MerchantOptions): x402ResourceServer {
  const server = new x402ResourceServer(facilitatorClientFor(opts)).register(opts.network, new ExactEvmServerScheme());
  if (opts.upto) server.register(opts.network, new UptoEvmServerScheme());
  return server;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

/** Official @x402/express middleware in front of a plain Express handler. */
export async function startExpressMerchant(opts: MerchantOptions): Promise<RunningMerchant> {
  const app = express();
  app.use(expressPaymentMiddleware(routesFor(opts), resourceServerFor(opts)));
  app.get("/paid", (_req, res) => {
    res.json({ ok: true, served: "express", at: Date.now() });
  });
  app.get("/upto", (_req, res) => {
    res.json({ ok: true, served: "express-upto" });
  });
  app.get("/free", (_req, res) => {
    res.json({ free: true });
  });
  const server = createServer(app);
  const url = await listen(server);
  return { url, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Official @x402/hono middleware on @hono/node-server. */
export async function startHonoMerchant(opts: MerchantOptions): Promise<RunningMerchant> {
  const app = new Hono();
  app.use(honoPaymentMiddleware(routesFor(opts), resourceServerFor(opts)));
  app.get("/paid", (c) => c.json({ ok: true, served: "hono" }));
  app.get("/free", (c) => c.json({ free: true }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
