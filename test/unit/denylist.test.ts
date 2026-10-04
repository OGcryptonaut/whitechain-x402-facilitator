import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileDenylist, parseDenylist, StaticDenylist } from "../../src/policy/denylist.js";
import { extractEvmAddressesFromSdnXml, renderDenylist } from "../../src/policy/ofac.js";

const A = "0x7F367cC41522cE07553e823bf3be79A889DEbe1B";
const B = "0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a";

describe("parseDenylist", () => {
  it("accepts one address per line, ignores comments, blanks and case", () => {
    const set = parseDenylist(`# header\n${A}\n\n   ${B.toUpperCase().replace("0X", "0x")}  # tornado\nnot-an-address\n`);
    expect(set.size).toBe(2);
    expect(set.has(A.toLowerCase())).toBe(true);
    expect(set.has(B)).toBe(true);
  });
});

describe("FileDenylist", () => {
  it("loads, matches case-insensitively, and reloads when the file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "denylist-"));
    const path = join(dir, "denylist.txt");
    writeFileSync(path, `${A}\n`);
    const list = new FileDenylist(path, { reloadSeconds: 0 });
    expect(list.size()).toBe(1);
    expect(list.isDenied(A.toLowerCase())).toBe(true);
    expect(list.isDenied(B)).toBe(false);
    writeFileSync(path, `${A}\n${B}\n`);
    const future = new Date(Date.now() + 5_000);
    utimesSync(path, future, future);
    expect(list.reload()).toBe(2);
    expect(list.isDenied(B)).toBe(true);
  });

  it("treats a missing file as an empty list", () => {
    const list = new FileDenylist(join(tmpdir(), "does-not-exist-" + Date.now()));
    expect(list.size()).toBe(0);
    expect(list.isDenied(A)).toBe(false);
  });
});

describe("StaticDenylist", () => {
  it("matches regardless of checksum casing", () => {
    const list = new StaticDenylist([A]);
    expect(list.isDenied(A.toLowerCase())).toBe(true);
    expect(list.isDenied(B)).toBe(false);
  });
});

describe("OFAC SDN XML extraction", () => {
  const xml = `<?xml version="1.0"?>
<sdnList xmlns="https://www.treasury.gov/ofac/downloads/sdn.xsd">
  <publshInformation><Publish_Date>09/25/2026</Publish_Date><Record_Count>1</Record_Count></publshInformation>
  <sdnEntry><uid>1</uid><sdnType>Entity</sdnType>
    <idList>
      <id><uid>10</uid><idType>Digital Currency Address - ETH</idType><idNumber>${A}</idNumber></id>
      <id><uid>11</uid><idType>Digital Currency Address - USDC</idType><idNumber>${A.toLowerCase()}</idNumber></id>
      <id><uid>12</uid><idType>Digital Currency Address - XBT</idType><idNumber>bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh</idNumber></id>
      <id><uid>13</uid><idType>Digital Currency Address - ARB</idType><idNumber>${B}</idNumber></id>
      <id><uid>14</uid><idType>Passport</idType><idNumber>0x0000000000000000000000000000000000000000</idNumber></id>
    </idList>
  </sdnEntry>
</sdnList>`;

  it("keeps only EVM digital-currency addresses, de-duplicated and lower-cased", () => {
    const result = extractEvmAddressesFromSdnXml(xml);
    expect(result.addresses).toEqual([B, A.toLowerCase()].sort());
    expect(result.byType).toEqual({ "Digital Currency Address - ETH": 1, "Digital Currency Address - USDC": 1, "Digital Currency Address - ARB": 1 });
    expect(result.publishDate).toBe("09/25/2026");
  });

  it("renders a denylist file the FileDenylist parser reads back", () => {
    const result = extractEvmAddressesFromSdnXml(xml);
    const text = renderDenylist(result, "https://example.invalid/sdn.xml", new Date(0));
    expect(text).toContain("# Source: https://example.invalid/sdn.xml");
    const parsed = parseDenylist(text);
    expect(parsed.size).toBe(2);
    expect(parsed.has(A.toLowerCase())).toBe(true);
  });
});
