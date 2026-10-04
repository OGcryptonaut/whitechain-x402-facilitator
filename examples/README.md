# Examples

Three runnable programs that show both sides of an x402 payment on Whitechain through the facilitator. Each is a standalone npm project (`npm install && npm start`) and reads its settings from a `.env` file (copy `.env.example`).

| Example | Side | What it does |
| --- | --- | --- |
| [`merchant-express/`](merchant-express) | Merchant | Express API with a paid `GET /weather` (`@x402/express`). |
| [`merchant-hono/`](merchant-hono) | Merchant | Hono API with a paid `POST /summarize` (`@x402/hono`). |
| [`agent-fetch/`](agent-fetch) | Agent | Pays either endpoint with `@x402/fetch`, prints the settlement transaction. |

Run a merchant in one terminal and the agent in another:

```sh
cd examples/merchant-express && cp .env.example .env   # fill in PAY_TO, ASSET_ADDRESS, FACILITATOR_URL
npm install && npm start

cd examples/agent-fetch && cp .env.example .env         # fill in AGENT_PRIVATE_KEY, ASSET_ADDRESS
npm install && npm start
```

The agent wallet needs test ITC from the token's faucet; it needs no WBT because the facilitator pays gas. The merchant needs nothing but an address.

To run everything locally without the public testnet, start the facilitator against a local Anvil chain as described in [`docs/OPERATIONS.md`](../docs/OPERATIONS.md#8-local-development) and point `FACILITATOR_URL` at it.
