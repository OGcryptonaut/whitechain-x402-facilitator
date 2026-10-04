// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface AnvilInstance {
  url: string;
  port: number;
  chainId: number;
  stop(): Promise<void>;
}

/** Picks a free TCP port by binding to 0 and releasing it. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      srv.close(() => resolve(address.port));
    });
  });
}

/**
 * Spawns `anvil` on an ephemeral port with instant mining. Chain id 31337 by default (any id works;
 * the facilitator takes the id from its NETWORKS config).
 */
export async function startAnvil(opts: { chainId?: number; extraArgs?: string[] } = {}): Promise<AnvilInstance> {
  const port = await freePort();
  const chainId = opts.chainId ?? 31337;
  const child: ChildProcess = spawn(
    "anvil",
    [
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--chain-id",
      String(chainId),
      "--silent",
      "--gas-limit",
      "60000000",
      ...(opts.extraArgs ?? []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited early (${child.exitCode}): ${stderr}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`anvil did not start within 30s: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    chainId,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
      }),
  };
}

/** Default anvil dev accounts (publicly known keys; test-only). */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;
