#!/usr/bin/env node
// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0
//
// Static site build: copies site/ to site/dist/ and substitutes build-time variables.
// Zero dependencies; runs on any Node >= 18.
//
//   node build.mjs                      # defaults (placeholders left in place)
//   SITE_URL=https://example.com FACILITATOR_URL=https://x402.example.com \
//   GOOGLE_SITE_VERIFICATION=abc123 node build.mjs
//
// Variables:
//   SITE_URL                  Canonical origin of the site. Replaces the default
//                             https://whitechain-x402-facilitator.vercel.app everywhere.
//   FACILITATOR_URL           Public facilitator origin. Replaces the https://x402-facilitator-production-ff5f.up.railway.app
//                             placeholder everywhere.
//   GOOGLE_SITE_VERIFICATION  Google Search Console token. When set, the
//                             <!-- google-site-verification --> marker becomes the meta tag;
//                             when unset the marker is removed.
//   BING_SITE_VERIFICATION    Same for Bing Webmaster Tools (msvalidate.01).
//   BUILD_DATE                YYYY-MM-DD used as sitemap <lastmod>. Defaults to today (UTC).

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

const DEFAULT_SITE_URL = "https://whitechain-x402-facilitator.vercel.app";
const FACILITATOR_PLACEHOLDER = "https://x402-facilitator-production-ff5f.up.railway.app";

const siteUrl = trimSlash(process.env.SITE_URL || DEFAULT_SITE_URL);
const facilitatorUrl = process.env.FACILITATOR_URL ? trimSlash(process.env.FACILITATOR_URL) : "";
const google = (process.env.GOOGLE_SITE_VERIFICATION || "").trim();
const bing = (process.env.BING_SITE_VERIFICATION || "").trim();
const buildDate = (process.env.BUILD_DATE || new Date().toISOString().slice(0, 10)).trim();

if (!/^https?:\/\/[^/\s]+$/.test(siteUrl)) fail(`SITE_URL must be an origin like https://example.com, got "${siteUrl}"`);
if (facilitatorUrl && !/^https?:\/\/[^/\s]+$/.test(facilitatorUrl)) fail(`FACILITATOR_URL must be an origin, got "${facilitatorUrl}"`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(buildDate)) fail(`BUILD_DATE must be YYYY-MM-DD, got "${buildDate}"`);
for (const [name, value] of [["GOOGLE_SITE_VERIFICATION", google], ["BING_SITE_VERIFICATION", bing]]) {
  if (value && !/^[A-Za-z0-9_-]+$/.test(value)) fail(`${name} must be a plain token, got "${value}"`);
}

const SKIP = new Set(["dist", "node_modules", "build.mjs", "vercel.json", "README.md", ".gitignore", ".DS_Store", ".vercel", ".env", ".env.local"]);
const TEXT = new Set([".html", ".css", ".xml", ".txt", ".webmanifest", ".json", ".svg"]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const verification = [
  google ? `<meta name="google-site-verification" content="${google}">` : "",
  bing ? `<meta name="msvalidate.01" content="${bing}">` : "",
]
  .filter(Boolean)
  .join("\n  ");

let leftover = [];
for (const file of walk(here)) {
  const rel = relative(here, file);
  const target = join(out, rel);
  mkdirSync(dirname(target), { recursive: true });
  if (!TEXT.has(extname(file))) {
    cpSync(file, target);
    continue;
  }
  let text = readFileSync(file, "utf8");
  text = text.split(DEFAULT_SITE_URL).join(siteUrl);
  if (facilitatorUrl) text = text.split(FACILITATOR_PLACEHOLDER).join(facilitatorUrl);
  if (extname(file) === ".html") {
    text = text.replace(/[ \t]*<!-- google-site-verification -->\n?/g, verification ? `  ${verification}\n` : "");
  }
  if (extname(file) === ".xml") {
    text = text.replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, `<lastmod>${buildDate}</lastmod>`);
  }
  if (text.includes(FACILITATOR_PLACEHOLDER)) leftover.push(rel);
  writeFileSync(target, text);
}

console.log(`site built to ${relative(process.cwd(), out) || "."}`);
console.log(`  SITE_URL          ${siteUrl}`);
console.log(`  FACILITATOR_URL   ${facilitatorUrl || "(unset: placeholder kept)"}`);
console.log(`  verification      google=${google ? "set" : "none"} bing=${bing ? "set" : "none"}`);
if (leftover.length) {
  console.warn(`warning: ${FACILITATOR_PLACEHOLDER} placeholder still present in: ${leftover.join(", ")}`);
  console.warn("         set FACILITATOR_URL=https://your-facilitator to replace it");
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function trimSlash(value) {
  return value.trim().replace(/\/+$/, "");
}

function fail(message) {
  console.error(`build.mjs: ${message}`);
  process.exit(1);
}
