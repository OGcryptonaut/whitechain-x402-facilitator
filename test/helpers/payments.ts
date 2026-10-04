// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/** Helpers to hand-craft (deliberately wrong) EIP-3009 payment payloads for negative tests. */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { getAddress, toHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signAuthorization(
  payer: PrivateKeyAccount,
  requirements: PaymentRequirements,
  authorization: Authorization,
): Promise<Hex> {
  const chainId = Number(requirements.network.split(":")[1]);
  return payer.signTypedData({
    domain: {
      name: requirements.extra["name"] as string,
      version: requirements.extra["version"] as string,
      chainId,
      verifyingContract: getAddress(requirements.asset),
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
}

/**
 * Builds a v2 payment payload like @x402/evm's client does, with optional overrides to produce
 * underpayments, expired or not-yet-valid authorizations, wrong recipients, etc.
 */
export async function buildEip3009Payment(
  payer: PrivateKeyAccount,
  requirements: PaymentRequirements,
  overrides: Partial<Authorization> = {},
): Promise<PaymentPayload> {
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: payer.address,
    to: getAddress(requirements.payTo),
    value: requirements.amount,
    validAfter: "0",
    validBefore: String(now + requirements.maxTimeoutSeconds),
    nonce: randomNonce(),
    ...overrides,
  };
  const signature = await signAuthorization(payer, requirements, authorization);
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { authorization, signature },
  };
}

export function requirementsFor(args: {
  network: `${string}:${string}`;
  asset: Address;
  payTo: Address;
  amount: string;
  name: string;
  version: string;
  maxTimeoutSeconds?: number;
  scheme?: string;
}): PaymentRequirements {
  return {
    scheme: args.scheme ?? "exact",
    network: args.network,
    asset: args.asset,
    amount: args.amount,
    payTo: args.payTo,
    maxTimeoutSeconds: args.maxTimeoutSeconds ?? 120,
    extra: { name: args.name, version: args.version },
  };
}

/** Raw POST to the facilitator (to assert HTTP status codes the SDK client hides). */
export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, headers: res.headers, body: parsed };
}
