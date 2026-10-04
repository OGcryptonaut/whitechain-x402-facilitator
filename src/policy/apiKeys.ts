// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { sha256Hex, type ApiKeyConfig } from "../config.js";

/**
 * Optional merchant API keys (`X-API-Key` header). A key only *raises* limits: without one the
 * facilitator stays usable on testnet. Keys are matched by SHA-256 digest with a constant-time
 * compare so neither the raw key nor its length leaks through timing.
 */
export class ApiKeyRegistry {
  private readonly byDigest = new Map<string, ApiKeyConfig>();

  constructor(keys: ApiKeyConfig[]) {
    for (const k of keys) {
      if (this.byDigest.has(k.digest)) throw new Error(`API_KEYS: duplicate key for ${k.name}`);
      this.byDigest.set(k.digest, k);
    }
  }

  get size(): number {
    return this.byDigest.size;
  }

  /** Returns the key's config, or undefined when the header is absent/unknown. */
  resolve(header: string | undefined): ApiKeyConfig | undefined {
    if (!header) return undefined;
    const digest = sha256Hex(header.trim());
    const candidate = this.byDigest.get(digest);
    if (!candidate) return undefined;
    // Map lookup already decided; the constant-time compare just avoids leaking digest prefixes
    // through hash-table timing on near-misses.
    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(candidate.digest, "hex");
    return a.length === b.length && timingSafeEqual(a, b) ? candidate : undefined;
  }
}
