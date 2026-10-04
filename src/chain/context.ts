// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import type { SettleGasCapError } from "../errors.js";

/**
 * Per-request side channel between the service and the signer wrapper. The @x402/evm scheme code
 * sits between them and only propagates reason *codes*, so facts the wrapper learns during a
 * verify/settle (an over-cap gas estimate, the estimated gas itself) are published here instead.
 */
export interface SettlementContext {
  gasCap?: SettleGasCapError;
  estimatedGas?: bigint;
}

export const settlementContext = new AsyncLocalStorage<SettlementContext>();
