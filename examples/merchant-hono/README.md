# merchant-hono

A Hono API with one paid endpoint, `POST /summarize`, that accepts x402 payments on Whitechain through the [Whitechain x402 Facilitator](../../README.md). It uses the official `@x402/hono` middleware unmodified with `@hono/node-server`; the same code runs on any runtime Hono supports.

## Run

```sh
cp .env.example .env    # set FACILITATOR_URL, PAY_TO, ASSET_ADDRESS
npm install
npm start
# merchant-hono listening on http://localhost:4022
```

Pay it from [`../agent-fetch`](../agent-fetch):

```sh
RESOURCE_URL=http://localhost:4022/summarize RESOURCE_METHOD=POST \
RESOURCE_BODY='{"text":"x402 works on Whitechain. The facilitator pays the gas."}' npm start
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACILITATOR_URL` | required | Facilitator base URL, no trailing slash. |
| `PAY_TO` | required | Your wallet. The payer's tokens go here directly. |
| `ASSET_ADDRESS` | required | EIP-3009 token to charge in (ITC on Whitechain Sepolia). |
| `ASSET_NAME`, `ASSET_VERSION` | `Inferit Test Credit`, `1` | The token's EIP-712 domain; must match the contract. |
| `PRICE_ATOMIC` | `2500` | Price in atomic units (0.0025 ITC). |
| `NETWORK` | `eip155:1874` | CAIP-2 network id. |
| `PORT` | `4022` | Listen port. |
| `FACILITATOR_API_KEY` | unset | Optional merchant key; sent as `X-API-Key`. |

POST routes work exactly like GET routes in x402: the 402 challenge, the signed retry and the settlement all happen on the same method and path, and the request body is forwarded unchanged on the paid retry.
