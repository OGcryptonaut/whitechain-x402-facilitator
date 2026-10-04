#!/usr/bin/env tsx
/**
 * Compiles the Solidity interop-test fixtures with Foundry's `forge` and writes a single
 * pre-compiled artifact bundle (ABI + creation bytecode) to test/fixtures/artifacts.json so the
 * test-suite does not need solc at runtime.
 *
 *   npm run build:fixtures
 *
 * Requires `forge` on PATH (https://getfoundry.sh). The artifacts are committed; rebuild only
 * when a fixture contract changes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const contractsDir = join(root, "test", "fixtures", "contracts");
const outDir = join(root, ".forge-out");
const cacheDir = join(root, ".forge-cache");

const CONTRACTS = ["TestEIP3009Token", "GasGuzzlerToken", "SimOnlyToken", "PlainToken", "MiniMulticall3"] as const;

rmSync(outDir, { recursive: true, force: true });
rmSync(cacheDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

execFileSync("forge", ["build", "--root", contractsDir, "--force"], { stdio: "inherit" });

const artifacts: Record<string, { abi: unknown[]; bytecode: `0x${string}`; compiler: string }> = {};
for (const name of CONTRACTS) {
  const file = join(outDir, "TestEIP3009Token.sol", `${name}.json`);
  const art = JSON.parse(readFileSync(file, "utf8")) as {
    abi: unknown[];
    bytecode: { object: string };
    metadata?: { compiler?: { version?: string } };
  };
  const bytecode = art.bytecode.object.startsWith("0x") ? art.bytecode.object : `0x${art.bytecode.object}`;
  artifacts[name] = {
    abi: art.abi,
    bytecode: bytecode as `0x${string}`,
    compiler: art.metadata?.compiler?.version ?? "unknown",
  };
}

const target = join(root, "test", "fixtures", "artifacts.json");
writeFileSync(target, `${JSON.stringify(artifacts, null, 2)}\n`);
rmSync(outDir, { recursive: true, force: true });
rmSync(cacheDir, { recursive: true, force: true });
console.log(`wrote ${target} (${Object.keys(artifacts).join(", ")})`);
