// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { FacilitatorConfig } from "./config.js";
import { Reasons } from "./errors.js";
import { FacilitatorService, type RequestContext } from "./facilitator.js";
import { LandingPage } from "./landing.js";
import type { Logger } from "./logger.js";
import { parseFacilitatorRequest } from "./schema.js";

const API_KEY_HEADER = "x-api-key";
const BODY_LIMIT_BYTES = 64 * 1024;

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
>;

export interface BuiltServer {
  app: AppInstance;
  service: FacilitatorService;
}

/**
 * HTTP surface. The three protocol endpoints match what @x402/core's HTTPFacilitatorClient calls:
 *
 *   GET  /supported                        -> { kinds, extensions, signers }
 *   POST /verify   { x402Version, paymentPayload, paymentRequirements } -> VerifyResponse
 *   POST /settle   { x402Version, paymentPayload, paymentRequirements } -> SettleResponse
 *
 * Plus GET / (landing), GET /health and GET /metrics. Error bodies keep the protocol shape so the
 * official client surfaces them as VerifyError / SettleError with our reason codes.
 */
export function buildServer(config: FacilitatorConfig, logger: Logger, service: FacilitatorService): BuiltServer {
  const app = Fastify({
    loggerInstance: logger.child({ component: "http" }),
    // One structured line per verify/settle is emitted by the service; skip Fastify's per-request pair.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: typeof config.trustProxy === "number" ? trustHops(config.trustProxy) : config.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { ignoreTrailingSlash: true },
    requestTimeout: 0,
  });
  const landing = new LandingPage(config, service.address);

  app.addHook("onRequest", async (request, reply) => {
    service.metrics.inc("http.requests");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    // The protocol endpoints are called server-to-server; GET endpoints are also read by browsers
    // (the docs site shows live status), so allow simple cross-origin reads.
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
    reply.header("Access-Control-Max-Age", "600");
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
    return undefined;
  });

  app.get("/", async (_request, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data:; font-src 'self' https: data:; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply.header("Cache-Control", "public, max-age=60");
    return reply.type("text/html; charset=utf-8").send(landing.html());
  });

  app.get("/health", async (_request, reply) => {
    const health = await service.health();
    return reply.status(200).send(health.body);
  });

  app.get("/metrics", async (_request, reply) => reply.send(service.metricsSnapshot()));

  app.get("/supported", async (_request, reply) => reply.send(service.supported()));

  app.post("/verify", async (request, reply) => {
    const ctx = resolveContext(request, reply, config, service, "verify");
    if (!ctx) return reply;
    const parsed = parseFacilitatorRequest(request.body);
    if (!parsed.ok) {
      service.metrics.inc("verify.total");
      service.metrics.inc("policy.invalid_request");
      return reply.status(400).send({ isValid: false, invalidReason: Reasons.invalidRequest, invalidMessage: parsed.message });
    }
    const outcome = await service.verify(parsed.value, ctx);
    if (outcome.retryAfterSeconds) reply.header("Retry-After", String(outcome.retryAfterSeconds));
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post("/settle", async (request, reply) => {
    const ctx = resolveContext(request, reply, config, service, "settle");
    if (!ctx) return reply;
    const parsed = parseFacilitatorRequest(request.body);
    if (!parsed.ok) {
      service.metrics.inc("settle.total");
      service.metrics.inc("policy.invalid_request");
      return reply.status(400).send({
        success: false,
        errorReason: Reasons.invalidRequest,
        errorMessage: parsed.message,
        transaction: "",
        network: networkFromBody(request.body),
      });
    }
    const outcome = await service.settle(parsed.value, ctx);
    if (outcome.retryAfterSeconds) reply.header("Retry-After", String(outcome.retryAfterSeconds));
    return reply.status(outcome.status).send(outcome.body);
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.status(404).send({ error: "not_found", message: `${request.method} ${request.url} is not an endpoint of this facilitator` }),
  );

  app.setErrorHandler(async (error: Error & { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error.message, url: request.url }, "request failed");
    }
    const message = status >= 500 ? "internal error" : error.message;
    if (request.url.startsWith("/verify")) {
      return reply.status(status).send({ isValid: false, invalidReason: status >= 500 ? Reasons.unexpectedVerifyError : Reasons.invalidRequest, invalidMessage: message });
    }
    if (request.url.startsWith("/settle")) {
      return reply.status(status).send({
        success: false,
        errorReason: status >= 500 ? Reasons.unexpectedSettleError : Reasons.invalidRequest,
        errorMessage: message,
        transaction: "",
        network: networkFromBody(request.body),
      });
    }
    return reply.status(status).send({ error: error.code ?? "error", message });
  });

  return { app, service };
}

/** Fastify's numeric trust-proxy form, expressed as the function form its types accept. */
function trustHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop <= hops;
}

/** Resolves client IP and API key; writes a 401 and returns undefined when the key is required/invalid. */
function resolveContext(
  request: FastifyRequest,
  reply: FastifyReply,
  config: FacilitatorConfig,
  service: FacilitatorService,
  op: "verify" | "settle",
): RequestContext | undefined {
  const headerValue = request.headers[API_KEY_HEADER];
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const apiKey = service.apiKeys.resolve(header);
  const unauthorized = (message: string) => {
    service.metrics.inc(`${op}.total`);
    service.metrics.inc("policy.unauthorized");
    reply.header("WWW-Authenticate", 'ApiKey realm="whitechain-x402-facilitator", header="X-API-Key"');
    if (op === "verify") {
      reply.status(401).send({ isValid: false, invalidReason: Reasons.invalidApiKey, invalidMessage: message });
    } else {
      reply.status(401).send({
        success: false,
        errorReason: Reasons.invalidApiKey,
        errorMessage: message,
        transaction: "",
        network: networkFromBody(request.body),
      });
    }
    return undefined;
  };
  if (header && !apiKey) return unauthorized("unknown X-API-Key");
  if (config.requireApiKey && !apiKey) return unauthorized("this facilitator requires an X-API-Key header");
  return { ip: request.ip, apiKey };
}

function networkFromBody(body: unknown): string {
  if (body && typeof body === "object") {
    const reqs = (body as Record<string, unknown>)["paymentRequirements"];
    if (reqs && typeof reqs === "object") {
      const network = (reqs as Record<string, unknown>)["network"];
      if (typeof network === "string") return network;
    }
  }
  return "";
}
