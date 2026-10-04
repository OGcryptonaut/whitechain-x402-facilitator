// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Paths that must never reach the log sink. Signatures, API keys and the signer key are redacted
 * even if a future code path accidentally logs a whole request object.
 */
export const REDACT_PATHS = [
  "*.signature",
  "*.*.signature",
  "*.*.*.signature",
  "signature",
  "payload.signature",
  "paymentPayload.payload.signature",
  "*.privateKey",
  "privateKey",
  "FACILITATOR_PRIVATE_KEY",
  "*.FACILITATOR_PRIVATE_KEY",
  "req.headers.authorization",
  "req.headers['x-api-key']",
  "headers.authorization",
  "headers['x-api-key']",
  "*.signedTransaction",
  "*.*.signedTransaction",
];

export function createLogger(level: string, extra: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: "whitechain-x402-facilitator" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...extra,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
