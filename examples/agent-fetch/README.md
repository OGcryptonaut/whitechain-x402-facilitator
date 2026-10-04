# agent-fetch

A TypeScript agent that pays an x402-protected API on Whitechain. It wraps `fetch` with `@x402/fetch`: on a `402` it signs an EIP-3009 authorization for the exact amount asked, retries with the payment header, and prints the settlement transaction. The agent needs the payment token (ITC on Whitechain Sepolia) and **no WBT**: the facilitator pays the gas.

## Run

```sh
cp .env.example .env    # set AGENT_PRIVATE_KEY (throwaway testnet key), ASSET_ADDRESS
npm install
npm start
```

Output:

```
agent 0xPayer -> GET http://localhost:4021/weather
status: 200
body:   {"city":"Lisbon","temperatureC":24,...}
paid:   success=true payer=0xPayer network=eip155:1874
tx:     https://explorer.testnet.whitechain.io/tx/0x...
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | required | Key of the paying wallet. Use a throwaway testnet key; fund it with ITC from the token's faucet. |
| `ASSET_ADDRESS` | required | Token the merchant charges in. Allowed explicitly in `spendControls`. |
| `RESOURCE_URL` | `http://localhost:4021/weather` | The paid endpoint. |
| `RESOURCE_METHOD`, `RESOURCE_BODY` | `GET`, unset | Method and JSON body (for `merchant-hono`'s `POST /summarize`). |
| `NETWORK` | `eip155:1874` | Only this network is registered; the agent will not pay on another chain. |
| `MAX_AMOUNT_ATOMIC` | `100000` | Hard cap per payment (0.10 with 6 decimals). Higher prices are refused before signing. |
| `EXPLORER_URL` | Whitechain Sepolia explorer | Used for the printed transaction link. |

## Why `spendControls`

`@x402/fetch` ships with a default-asset allowlist (USDC on the chains the SDK knows). Whitechain tokens are not in that list, so without an `allowedAssets` entry the client refuses to pay with "All payment requirements were rejected by spendControls". The entry also carries a per-payment cap, which is the right place for an agent's budget guard.
