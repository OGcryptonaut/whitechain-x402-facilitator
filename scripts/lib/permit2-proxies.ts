// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic deployment of the x402 Permit2 proxies to their canonical addresses.
 *
 * Both contracts are deployed through Arachnid's CREATE2 deployer (0x4e59…956C), which exists on
 * Whitechain Sepolia (and on anvil). The address depends only on (deployer, salt, keccak256(initCode)),
 * never on who sends the transaction, so anyone with gas can deploy them. The init codes vendored in
 * ../data/ come from the x402 repository (Apache-2.0):
 *
 *   - exact: `contracts/evm/script/data/exact-proxy-initcode.hex` (pre-built; its CBOR metadata
 *     is part of the canonical bytecode, so it cannot be rebuilt from source)
 *   - upto:  compiled from `contracts/evm` at commit 751590a with solc 0.8.28, cbor_metadata=false,
 *     plus the ABI-encoded canonical Permit2 constructor argument.
 *
 * Both hashes and the resulting addresses are asserted here before anything is sent.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concatHex,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";

export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export type ProxyKind = "exact" | "upto";

export interface ProxySpec {
  kind: ProxyKind;
  contract: string;
  salt: Hex;
  initCodeHash: Hex;
  address: Address;
  file: string;
}

export const PROXIES: Record<ProxyKind, ProxySpec> = {
  exact: {
    kind: "exact",
    contract: "x402ExactPermit2Proxy",
    salt: "0x0000000000000000000000000000000000000000000000003000000007263b0e",
    initCodeHash: "0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c",
    address: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
    file: "exact-proxy-initcode.hex",
  },
  upto: {
    kind: "upto",
    contract: "x402UptoPermit2Proxy",
    salt: "0x000000000000000000000000000000000000000000000000b000000001db633d",
    initCodeHash: "0x74f7a29cbc3c55f87cdef7f7c551643189e8bb62eed9de67753aebc402b83797",
    address: "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
    file: "upto-proxy-initcode.hex",
  },
};

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/** Loads and cryptographically checks an init code: hash and CREATE2 address must match the canonical values. */
export function loadInitCode(kind: ProxyKind): Hex {
  const spec = PROXIES[kind];
  const raw = readFileSync(join(dataDir, spec.file), "utf8").trim();
  const initCode = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const hash = keccak256(initCode);
  if (hash !== spec.initCodeHash) {
    throw new Error(`${spec.file}: keccak256 ${hash} does not match canonical ${spec.initCodeHash}`);
  }
  const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: spec.salt, bytecodeHash: hash });
  if (address.toLowerCase() !== spec.address.toLowerCase()) {
    throw new Error(`${spec.file}: CREATE2 address ${address} does not match canonical ${spec.address}`);
  }
  return initCode;
}

export interface DeploymentStatus {
  chainId: number;
  deployer: boolean;
  permit2: boolean;
  exact: boolean;
  upto: boolean;
}

export async function checkDeployment(client: PublicClient): Promise<DeploymentStatus> {
  const has = async (address: Address) => {
    const code = await client.getCode({ address });
    return !!code && code !== "0x";
  };
  const [chainId, deployer, permit2, exact, upto] = await Promise.all([
    client.getChainId(),
    has(CREATE2_DEPLOYER),
    has(PERMIT2),
    has(PROXIES.exact.address),
    has(PROXIES.upto.address),
  ]);
  return { chainId, deployer, permit2, exact, upto };
}

/**
 * Deploys one proxy via the CREATE2 deployer: calldata is `salt ++ initCode`. Returns the tx hash,
 * or undefined when the contract already exists. Throws if no code appears at the canonical address.
 */
export async function deployProxy(
  wallet: WalletClient<ReturnType<typeof import("viem").http>, Chain, Account>,
  client: PublicClient,
  kind: ProxyKind,
): Promise<Hex | undefined> {
  const spec = PROXIES[kind];
  const existing = await client.getCode({ address: spec.address });
  if (existing && existing !== "0x") return undefined;
  const initCode = loadInitCode(kind);
  const hash = await wallet.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: concatHex([spec.salt, initCode]),
    gas: 1_000_000n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${spec.contract}: deployment tx ${hash} reverted`);
  const code = await client.getCode({ address: spec.address });
  if (!code || code === "0x") throw new Error(`${spec.contract}: no code at ${spec.address} after ${hash}`);
  return hash;
}
