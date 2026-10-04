// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import type { DestinationStream } from "pino";
import { loadConfig, type FacilitatorConfig } from "../../src/config.js";
import { FacilitatorService, type FacilitatorServiceDeps } from "../../src/facilitator.js";
import { createLogger } from "../../src/logger.js";
import { buildServer, type AppInstance } from "../../src/server.js";
import type { AnvilInstance } from "./anvil.js";

export interface RunningFacilitator {
  url: string;
  service: FacilitatorService;
  app: AppInstance;
  config: FacilitatorConfig;
  stop(): Promise<void>;
}

/** The parts of an anvil instance the facilitator config needs; lets tests point at dead RPCs too. */
export type NetworkEndpoint = Pick<AnvilInstance, "url" | "chainId">;

export interface StartFacilitatorOptions {
  /** Extra fields merged into the primary network's NETWORKS entry (e.g. an asset allowlist). */
  networkExtra?: Record<string, unknown>;
  /** Additional networks (other anvils) the facilitator serves alongside the primary one. */
  extraNetworks?: NetworkEndpoint[];
  /** Capture log output (set LOG_LEVEL in `env` to something other than silent). */
  logDestination?: DestinationStream;
}

/**
 * Starts the facilitator in-process on an ephemeral port, configured for the anvil network.
 * `env` overrides the defaults (same names as production env vars).
 */
export async function startFacilitator(
  anvil: NetworkEndpoint,
  privateKey: `0x${string}`,
  env: Record<string, string> = {},
  deps: FacilitatorServiceDeps = {},
  opts: StartFacilitatorOptions = {},
): Promise<RunningFacilitator> {
  const networks = JSON.stringify([
    {
      id: `eip155:${anvil.chainId}`,
      name: "anvil",
      rpc: anvil.url,
      explorer: "https://explorer.example.invalid",
      nativeSymbol: "ETH",
      ...opts.networkExtra,
    },
    ...(opts.extraNetworks ?? []).map((n) => ({
      id: `eip155:${n.chainId}`,
      name: `anvil-${n.chainId}`,
      rpc: n.url,
      nativeSymbol: "ETH",
    })),
  ]);
  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: process.env.FACILITATOR_TEST_LOG ?? "silent",
    FACILITATOR_PRIVATE_KEY: privateKey,
    NETWORKS: networks,
    DENYLIST_FILE: "test/fixtures/nonexistent-denylist.txt",
    PROXY_PROBE_MINUTES: "0",
    CONFIRMATION_TIMEOUT_MS: "30000",
    ...env,
  });
  const logger = createLogger(config.logLevel, {}, opts.logDestination);
  const service = new FacilitatorService(config, logger, deps);
  const { app } = buildServer(config, logger, service);
  await service.start();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    service,
    app,
    config,
    async stop() {
      service.stop();
      await app.close();
    },
  };
}
