// Copyright 2026 Sahil Massey and contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ANVIL_KEYS, type AnvilInstance } from "./anvil.js";
import { deployProxy, PERMIT2, PROXIES } from "../../scripts/lib/permit2-proxies.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

type Artifact = { abi: Abi; bytecode: Hex; compiler: string };
export const ARTIFACTS = JSON.parse(readFileSync(join(fixtures, "artifacts.json"), "utf8")) as Record<
  "TestEIP3009Token" | "GasGuzzlerToken" | "SimOnlyToken" | "PlainToken" | "MiniMulticall3",
  Artifact
>;

export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export interface ChainFixture {
  chain: Chain;
  publicClient: PublicClient;
  deployer: PrivateKeyAccount;
  /** EIP-3009 + EIP-2612 token: name "Test USD", version "1", 6 decimals. */
  token: Address;
  tokenName: string;
  tokenVersion: string;
  /** EIP-3009 token whose transfers burn >1M gas. */
  guzzler: Address;
  /** EIP-3009 token whose transfer passes eth_call simulation but reverts in a real transaction. */
  simOnly: Address;
  /** ERC-20 without EIP-3009. */
  plain: Address;
  permit2Deployed: boolean;
  proxies: { exact: boolean; upto: boolean };
  mint(token: Address, to: Address, amount: bigint): Promise<void>;
  balanceOf(token: Address, who: Address): Promise<bigint>;
  nativeBalance(who: Address): Promise<bigint>;
  fund(to: Address, wei: bigint): Promise<void>;
  /** Approves Permit2 for `owner` (needs the owner to hold gas). */
  approvePermit2(owner: PrivateKeyAccount, token: Address): Promise<void>;
  /** Advances anvil's clock (seconds) and mines a block. */
  warp(seconds: number): Promise<void>;
}

export function anvilChain(anvil: AnvilInstance): Chain {
  return defineChain({
    id: anvil.chainId,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [anvil.url] } },
  });
}

/**
 * Deploys the fixtures on a fresh anvil:
 *  - the test tokens,
 *  - Multicall3 (minimal tryAggregate) at its canonical address (the SDK's failure diagnosis uses it),
 *  - Permit2 at its canonical address (runtime code captured from Whitechain Sepolia),
 *  - the x402 Permit2 proxies through the CREATE2 deployer (same path as the real deploy script).
 */
export async function deployFixtures(anvil: AnvilInstance, opts: { permit2?: boolean } = {}): Promise<ChainFixture> {
  const chain = anvilChain(anvil);
  const transport = http(anvil.url);
  const publicClient = createPublicClient({ chain, transport });
  const testClient = createTestClient({ chain, transport, mode: "anvil" });
  const deployer = privateKeyToAccount(ANVIL_KEYS[0]);
  const wallet = createWalletClient({ account: deployer, chain, transport });

  const deploy = async (artifact: Artifact, args: unknown[] = []): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("deploy failed");
    return receipt.contractAddress;
  };

  const token = await deploy(ARTIFACTS.TestEIP3009Token, ["Test USD", "TUSD"]);
  const guzzler = await deploy(ARTIFACTS.GasGuzzlerToken);
  const plain = await deploy(ARTIFACTS.PlainToken);
  const simOnly = await deploy(ARTIFACTS.SimOnlyToken);

  // Multicall3: deploy, copy the runtime code to the canonical address.
  const multicallTmp = await deploy(ARTIFACTS.MiniMulticall3);
  const multicallCode = await publicClient.getCode({ address: multicallTmp });
  await testClient.setCode({ address: MULTICALL3_ADDRESS, bytecode: multicallCode! });

  let permit2Deployed = false;
  const proxies = { exact: false, upto: false };
  if (opts.permit2 !== false) {
    const permit2Runtime = readFileSync(join(fixtures, "permit2-runtime.hex"), "utf8").trim() as Hex;
    await testClient.setCode({ address: PERMIT2, bytecode: permit2Runtime });
    permit2Deployed = true;
    await deployProxy(wallet, publicClient, "exact");
    await deployProxy(wallet, publicClient, "upto");
    proxies.exact = !!(await publicClient.getCode({ address: PROXIES.exact.address }));
    proxies.upto = !!(await publicClient.getCode({ address: PROXIES.upto.address }));
  }

  const erc20Abi = ARTIFACTS.TestEIP3009Token.abi;
  return {
    chain,
    publicClient,
    deployer,
    token,
    tokenName: "Test USD",
    tokenVersion: "1",
    guzzler,
    simOnly,
    plain,
    permit2Deployed,
    proxies,
    async mint(t, to, amount) {
      const hash = await wallet.writeContract({ address: t, abi: erc20Abi, functionName: "mint", args: [to, amount] });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    balanceOf: (t, who) =>
      publicClient.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
    nativeBalance: (who) => publicClient.getBalance({ address: who }),
    async fund(to, wei) {
      const hash = await wallet.sendTransaction({ to, value: wei });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    async approvePermit2(owner, t) {
      const ownerWallet = createWalletClient({ account: owner, chain, transport });
      const hash = await ownerWallet.writeContract({
        address: t,
        abi: erc20Abi,
        functionName: "approve",
        args: [PERMIT2, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    async warp(seconds) {
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
  };
}

export const ONE_ETHER = parseEther("1");
