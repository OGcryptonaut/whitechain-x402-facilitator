// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Extracts EVM addresses from the OFAC Specially Designated Nationals (SDN) list in XML form.
 * SDN entries carry digital-currency identifiers such as
 *
 *   <id><idType>Digital Currency Address - ETH</idType><idNumber>0x…</idNumber></id>
 *
 * (also "- USDC", "- USDT", "- ARB", "- BSC", "- ETC" …). Every `Digital Currency Address - *`
 * identifier whose value is a 20-byte hex address is returned, lower-cased and de-duplicated,
 * regardless of the chain label: an address sanctioned on one EVM chain is the same key pair on
 * Whitechain.
 */
export interface OfacExtraction {
  addresses: string[];
  /** idType labels seen, e.g. { "Digital Currency Address - ETH": 512 } */
  byType: Record<string, number>;
  publishDate: string | undefined;
}

const ID_BLOCK = /<id>([\s\S]*?)<\/id>/g;
const ID_TYPE = /<idType>\s*([^<]*?)\s*<\/idType>/;
const ID_NUMBER = /<idNumber>\s*([^<]*?)\s*<\/idNumber>/;
const PUBLISH_DATE = /<Publish_Date>\s*([^<]*?)\s*<\/Publish_Date>/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function extractEvmAddressesFromSdnXml(xml: string): OfacExtraction {
  const addresses = new Set<string>();
  const byType: Record<string, number> = {};
  for (const match of xml.matchAll(ID_BLOCK)) {
    const block = match[1] ?? "";
    const type = ID_TYPE.exec(block)?.[1];
    if (!type || !type.startsWith("Digital Currency Address")) continue;
    const value = ID_NUMBER.exec(block)?.[1]?.trim();
    if (!value || !EVM_ADDRESS.test(value)) continue;
    addresses.add(value.toLowerCase());
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    addresses: [...addresses].sort(),
    byType,
    publishDate: PUBLISH_DATE.exec(xml)?.[1],
  };
}

/** Renders a denylist file body with provenance comments. */
export function renderDenylist(extraction: OfacExtraction, source: string, fetchedAt: Date): string {
  const lines = [
    "# Sanctions denylist for whitechain-x402-facilitator (DENYLIST_FILE).",
    `# Source: ${source}`,
    `# SDN publish date: ${extraction.publishDate ?? "unknown"}; fetched ${fetchedAt.toISOString()}`,
    `# ${extraction.addresses.length} EVM addresses from identifier types: ${Object.keys(extraction.byType).join(", ") || "none"}`,
    "# One address per line; '#' starts a comment. Regenerate with: npm run denylist:ofac",
    ...extraction.addresses,
  ];
  return `${lines.join("\n")}\n`;
}
