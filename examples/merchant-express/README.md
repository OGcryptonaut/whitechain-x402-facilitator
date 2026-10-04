# merchant-express

An Express API with one paid endpoint, `GET /weather`, that accepts x402 payments on Whitechain through the [Whitechain x402 Facilitator](../../README.md). It uses the official `@x402/express` middleware unmodified; the only Whitechain-specific parts are the facilitator URL, the network id `eip155:1874`, and an explicit token price.

## Run

```sh
cp .env.example .env    # set FACILITATOR_URL, PAY_TO, ASSET_ADDRESS
npm install
npm start
# merchant-express listening on http://localhost:4021
```

Then, from [`../agent-fetch`](../agent-fetch), pay it:

```sh
RESOURCE_URL=http://localhost:4021/weather npm start
```

Or look at the unpaid response yourself:

```sh
curl -i http://localhost:4021/weather
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 JSON with the price, token, payTo and network>
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACILITATOR_URL` | required | Facilitator base URL, no trailing slash. |
| `PAY_TO` | required | Your wallet. The payer's tokens go here directly. |
| `ASSET_ADDRESS` | required | EIP-3009 token to charge in (ITC on Whitechain Sepolia). |
| `ASSET_NAME`, `ASSET_VERSION` | `Inferit Test Credit`, `1` | The token's EIP-712 domain; must match the contract. |
| `PRICE_ATOMIC` | `10000` | Price in atomic units (0.01 ITC). |
| `NETWORK` | `eip155:1874` | CAIP-2 network id. |
| `PORT` | `4021` | Listen port. |
| `FACILITATOR_API_KEY` | unset | Optional merchant key; sent as `X-API-Key` on verify, settle and supported. |

## What happens on a request

1. Unpaid `GET /weather` returns `402` with a `PAYMENT-REQUIRED` header describing the price.
2. The client signs an EIP-3009 authorization for exactly `PRICE_ATOMIC` and retries with `PAYMENT-SIGNATURE`.
3. The middleware POSTs to the facilitator's `/verify`; if valid, the route handler runs.
4. After the handler responds, the middleware POSTs to `/settle`; the facilitator submits the transfer on chain and pays the gas. The response carries a `PAYMENT-RESPONSE` header with the transaction hash.

The handler only ever runs for verified payments. Settlement failures after the handler are reported in the response (`settlementFailedResponseBody` in the route config lets you customise that).
