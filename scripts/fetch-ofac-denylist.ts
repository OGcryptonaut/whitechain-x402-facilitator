#!/usr/bin/env tsx
// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the sanctions denylist from the public OFAC SDN list.
 *
 *   npm run denylist:ofac                 # writes ./denylist.txt
 *   OFAC_SDN_URL=... OUT=path tsx scripts/fetch-ofac-denylist.ts
 *
 * Source: the U.S. Treasury's SDN list in XML (https://sanctionslistservice.ofac.treas.gov/, the
 * legacy https://www.treasury.gov/ofac/downloads/sdn.xml URL redirects there). Only
 * `Digital Currency Address - *` identifiers that are EVM addresses are kept. Run it on a schedule
 * (daily is plenty); the facilitator re-reads the file when its mtime changes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractEvmAddressesFromSdnXml, renderDenylist } from "../src/policy/ofac.js";

const source = process.env.OFAC_SDN_URL ?? "https://www.treasury.gov/ofac/downloads/sdn.xml";
const out = resolve(process.env.OUT ?? "denylist.txt");

console.log(`fetching ${source} ...`);
const res = await fetch(source, { redirect: "follow", headers: { accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" } });
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
const xml = await res.text();
const extraction = extractEvmAddressesFromSdnXml(xml);
if (extraction.addresses.length === 0) {
  console.error("no EVM digital-currency addresses found; refusing to write an empty denylist");
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderDenylist(extraction, source, new Date()));
console.log(`wrote ${out}: ${extraction.addresses.length} addresses (SDN publish date ${extraction.publishDate ?? "unknown"})`);
for (const [type, count] of Object.entries(extraction.byType)) console.log(`  ${type}: ${count}`);
