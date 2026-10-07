# @voidly/agent-wallet

A locally held Base USDC wallet for agents. It exposes an ESM library, a stdio MCP server, and a `voidly-agent-wallet` CLI for seller onboarding and bounded Marketplace purchases. The 0.x API may change; review its spending limits and keep wallet recovery material in your own secret manager. Node.js 20 or newer is required.

## Sell and buy with 0.2.0

Build this checkout with `npm ci && npm run build`. The commands below use an **existing encrypted local wallet** in `VOIDLY_WALLET_STATE_DIR` (or the default state directory described below) and the matching `VOIDLY_WALLET_RECOVERY_SECRET` supplied by your secret manager. They never create a new wallet or accept a private key on the command line. `--network` is required for each invocation.

Create `listing.json` with the service that your HTTPS upstream will provide:

```json
{
  "name": "Example text service",
  "description": "Returns a short text response for a prompt.",
  "category": "text",
  "upstreamUrl": "https://seller.example.com/service",
  "method": "POST",
  "priceAtomic": 10000,
  "inputSchema": { "type": "object" },
  "outputSchema": { "type": "object" }
}
```

`priceAtomic` is USDC with six decimal places, so `10000` is 0.01 USDC. Run a local validation pass, then create the listing:

```sh
node dist/cli.js sell --network base-sepolia --listing ./listing.json --dry-run
node dist/cli.js sell --network base-sepolia --listing ./listing.json
```

`sell` signs the exact seller registration and listing creation challenges, submits both, and returns a **pending** listing ID and version. It writes the gateway's one-time HMAC health secret to a private, newly created file under the wallet state directory and prints only that file path. You may select another existing private directory with `--secret-file /absolute/private/path.json`; the target file must not already exist. Install that secret and listing ID on your upstream, then complete the gateway's separate health check and activation step. A pending listing is not yet a live catalog service. If the create response is uncertain, do not retry: retain the private attempt marker and seek seller API or operator reconciliation, because a retry can create a second listing.

To buy a live seller listing, put the service input in `input.json`, find its exact ID and version in the Marketplace catalog, and choose all three caps yourself:

```sh
node dist/cli.js buy svc_0123456789 --network base-sepolia --version 1 \
  --input ./input.json --per-call-usdc 0.02 --daily-usdc 0.05 --max-usdc 0.01 --dry-run
node dist/cli.js buy svc_0123456789 --network base-sepolia --version 1 \
  --input ./input.json --per-call-usdc 0.02 --daily-usdc 0.05 --max-usdc 0.01
```

Replace the sample ID, version, and input with a real live listing. For Base mainnet, use `--network base`; it selects the fixed production gateway and Circle-issued Base USDC. The command fetches one exact live seller detail record, rejects a listed price above `--max-usdc`, and pins its ID, version, and seller wallet to the signed x402 quote before authorization. The durable local spend ledger enforces the per-call and UTC-day caps. `--dry-run` only checks local arguments and JSON; it never loads the wallet, contacts a gateway, signs, or pays. An actual purchase returns `verifiedStatus` (`delivered` or `refund_owed`), the HTTP result, and available receipt metadata as JSON. `refund_owed` is an obligation, not a completed refund. If it reports `paymentMayHaveSettled: true` or an incomplete body, preserve the attempt and recover the original quote; **do not run `buy` again for that attempt**.

The CLI reads the same durable Marketplace attempts as the MCP wallet. To find or recover the original quote without another payment:

```sh
node dist/cli.js attempts --network base-sepolia
node dist/cli.js recover 0xYOUR_ORIGINAL_64_HEX_QUOTE_ID --network base-sepolia
```

Use the exact quote ID from the uncertain result, signed receipt, or retained attempt list. Keep the wallet state directory and recovery secret across restarts; restoring only the wallet key does not recreate past payment attempts. A verified `refund_owed` result and an incomplete result exit with nonzero status so scripts do not mistake them for delivery.

## Run the MCP server

For the published 0.2.0 MCP release, install the exact package version in your agent project:

```sh
npm install --save-exact @voidly/agent-wallet@0.2.0
VOIDLY_WALLET_NETWORK=base-sepolia \
VOIDLY_WALLET_PER_CALL_USDC=0.02 \
VOIDLY_WALLET_DAILY_USDC=0.05 \
./node_modules/.bin/voidly-agent-wallet-mcp
```

For a reviewed source checkout, build and run it directly:

```sh
npm ci
npm run build
VOIDLY_WALLET_NETWORK=base-sepolia \
VOIDLY_WALLET_PER_CALL_USDC=0.02 \
VOIDLY_WALLET_DAILY_USDC=0.05 \
node dist/mcp.js
```

Configure your MCP host to run the installed binary or source command over stdio. `VOIDLY_WALLET_STATE_DIR` selects a private, durable directory for the encrypted backup, spend ledger, and Marketplace recovery records. Keep the same directory across restarts. Base Sepolia defaults to the production and staging Voidpay payment origins. To restrict a staging run, set `VOIDLY_WALLET_ALLOWED_ORIGINS=https://x402-staging.voidly.ai`. Base mainnet requires both `VOIDLY_WALLET_NETWORK=base` and an explicit comma-separated `VOIDLY_WALLET_ALLOWED_ORIGINS` list before startup.

## Install in Claude Code or Cursor

These examples run the published local stdio server from `@voidly/agent-wallet@0.2.0`. They use Base Sepolia with per-call and daily caps of 0.02 and 0.05 USDC. Node.js 20 or newer and npm are required. The package has separate CLI and MCP executables, so select `voidly-agent-wallet-mcp` explicitly.

In the Claude Code project that needs the wallet, add it with local scope:

```sh
claude mcp add \
  --env VOIDLY_WALLET_NETWORK=base-sepolia \
  --env VOIDLY_WALLET_PER_CALL_USDC=0.02 \
  --env VOIDLY_WALLET_DAILY_USDC=0.05 \
  --transport stdio voidly-agent-wallet -- npx -y --package=@voidly/agent-wallet@0.2.0 voidly-agent-wallet-mcp
```

For Cursor, create `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "voidly-agent-wallet": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package=@voidly/agent-wallet@0.2.0", "voidly-agent-wallet-mcp"],
      "env": {
        "VOIDLY_WALLET_NETWORK": "base-sepolia",
        "VOIDLY_WALLET_PER_CALL_USDC": "0.02",
        "VOIDLY_WALLET_DAILY_USDC": "0.05"
      }
    }
  }
}
```

By default, local state uses `$XDG_STATE_HOME/voidly-agent-wallet` when `XDG_STATE_HOME` is set, or `~/.local/state/voidly-agent-wallet` otherwise. `VOIDLY_WALLET_STATE_DIR` overrides both; choose a private, durable path and preserve the full directory across restarts. The examples contain no wallet key or recovery secret. Keep any later `VOIDLY_WALLET_RECOVERY_SECRET` or `VOIDLY_AGENT_KEY` value in your secret manager and out of project files. Your MCP host may log tool results, including a generated recovery secret.

## MCP tools

| Tool | Input | Result |
| --- | --- | --- |
| `voidly_capabilities` | `{}` | **B505 source only; not in published 0.2.0.** One read-only call returns the public capability manifest's listed actions, endpoints, related endpoints, availability and coverage. No wallet is needed. |
| `wallet_generate_recovery_secret` | `{}` | One random 32-byte secret. Treat the MCP result as sensitive and save it in your own secret manager before wallet creation. |
| `wallet_create` | `{}` | Create a wallet and store its encrypted backup before returning its address. |
| `wallet_restore_local` | `{}` | Restore the local encrypted backup using `VOIDLY_WALLET_RECOVERY_SECRET`. |
| `wallet_restore_relay` | Optional `address` or `backupKey` | Restore a client-encrypted Relay backup using the recovery secret and `VOIDLY_AGENT_KEY`. |
| `wallet_address` | `{}` | Loaded wallet address. |
| `wallet_receive_info` | `{}` | Address, network, and USDC asset for receiving funds. |
| `wallet_funding_request` | `{amountUsdc?: string, expectedChainId?: number}` | Base USDC EIP-681 transfer URI and locally generated SVG QR for the loaded wallet. |
| `wallet_balance` | `{}` | USDC balance from the configured Base RPC. |
| `wallet_prepare_voidly_seller_registration` | `{}` | Fetch and validate one Voidly seller-registration challenge, sign it with the loaded wallet, and return the fixed registration submit path and body. It does not submit registration. |
| `wallet_pay_x402` | `{url, method?: "GET" \| "POST", body?, maxAmountUsd?}` | Bounded paid HTTP result, or a structured uncertainty result after a signed retry. |
| `wallet_marketplace_attempts` | `{}` | Retained quote and payment coordinates for this wallet. |
| `wallet_recover_marketplace` | `{quoteId}` | Fresh payer-authenticated result GET for the original Marketplace payment; no second payment. |
| `wallet_backup_relay` | `{}` | Save another encrypted backup in Relay memory; returns its backup key. |

The B505 source tool reads only `https://voidly.ai/.well-known/voidly.json`. It returns an error while that manifest is unavailable. The manifest's `coverage` and each action's availability remain explicit: a partial catalog or source-wired endpoint does not prove a live route. The tool lists routes; it does not invoke them, load a wallet, sign, or pay.

`wallet_create` needs a generated recovery secret. Use `wallet_generate_recovery_secret` in a fresh process, save the value outside Voidly and this repository, then create the wallet in that process. On restart, supply the saved value as `VOIDLY_WALLET_RECOVERY_SECRET` to restore or make another backup. Losing the secret makes the encrypted backup unusable. This tool returns the secret through your MCP host, which may log the result. Protect host logs and never include the secret in a prompt or payment request.

The default network is Base Sepolia. Per-call and UTC-day caps default to 1 and 5 USDC; set `VOIDLY_WALLET_PER_CALL_USDC` and `VOIDLY_WALLET_DAILY_USDC` lower for a bounded run. The wallet reserves the full authorization before signing. An uncertain result still uses that day's local budget. Payment requires a durable local spend ledger; `VOIDLY_WALLET_MEMORY_ONLY=1` supports encrypted Relay backup and restore but refuses payment.

Preserve the full local state directory. Relay backup covers the encrypted wallet key, not the local spend ledger or Marketplace attempt records. Restoring the key alone does not restore recovery for earlier Marketplace purchases. If an MCP restore finds no local spend ledger, new payments pause until the next UTC day.

## Fund this agent

Call `wallet_funding_request` after loading a wallet, or use `await wallet.fundingRequest({ amountUsdc: '1.25', expectedChainId: 8453 })` from the library when the wallet is configured for Base mainnet. The result includes the agent address, chain ID, USDC contract address, EIP-681 `uri`, and `qrSvg`. Base mainnet uses chain 8453; Base Sepolia uses 84532. `expectedChainId` rejects a request for a different chain. `amountUsdc` is optional; positive values can have up to nine whole-number digits and six decimal places. With no amount, the URI still identifies a USDC transfer to the agent, and a compatible payer wallet should ask for the amount.

The QR is generated locally from the URI. It does not send a transaction, contact a network, reveal a key, or change the wallet's spending limits. Wallet support for EIP-681 token transfers and chain switching varies. Before approving a transfer, the payer must verify the chain, USDC contract, recipient address, and amount in their wallet. Do not treat a displayed QR or a wallet-open action as proof that funds arrived; check the balance or transaction separately.

**Optional fiat purchase:** An eligible operator can [buy USDC through MoonPay](https://www.moonpay.com/buy/usdc) into a wallet they own and control. If MoonPay offers USDC on Base in that checkout, the operator can then make a separate, authorized Base USDC transfer to the verified agent address using this funding request. Check the token, chain, destination, net amount, and fees in each flow. MoonPay handles its own identity checks and availability. This kit does not construct a MoonPay checkout or collect its payment or identity data. See [MoonPay's purchase guide](https://support.moonpay.com/en/articles/380500-how-do-i-buy-cryptocurrency-with-moonpay) and [US wallet terms](https://www.moonpay.com/legal/terms_of_use_usa).

[MoonAgents Card](https://support.moonpay.com/en/articles/629708-moonagents-card-crypto-funded-virtual-payment-cards) is a separate virtual-card product backed by supported Solana assets. It does not fund this Base wallet or make a Voidpay x402 payment.

`wallet_prepare_voidly_seller_registration` takes no arguments. It uses the loaded wallet address to request a one-use registration challenge from `https://x402.voidly.ai` on Base mainnet or `https://x402-staging.voidly.ai` on Base Sepolia. That exact origin must also be in the configured origin allowlist. Before signing, the wallet checks the canonical SIWE message against that domain, its exact `/v1/providers/challenge` URI, the selected Base chain, the wallet address, the validity window, the registration resource, and the exact statement `Authorize one Voidly marketplace mutation. This does not transfer funds.` It returns `{submitUrl, body: {payload: {}, message, signature}}`, where `submitUrl` is the fixed origin's `/v1/providers/register` endpoint. The caller POSTs `body` to `submitUrl`; the tool does not submit registration, sign a listing mutation, transfer funds, or expose a general message signer.

Call `wallet_pay_x402` only for an origin you intend to pay. For a Voidpay Marketplace service, use the listing's public `callUrl`, `method: "POST"`, its JSON input as `body`, and a `maxAmountUsd` you accept. The live 402 challenge sets the payable terms; a catalog card is discovery data.

After a signed retry, `paymentMayHaveSettled: true` means **do not pay again**. When the result contains a Marketplace `quoteId`, preserve the local attempt record, use `wallet_marketplace_attempts` if needed, then call `wallet_recover_marketplace` with that quote. For other x402 services, `quoteId` and `recoverWith` can be `null`; this kit provides no built-in result-recovery tool for those payments. A delivered recovery includes `verifiedStatus`, the signed receipt, and returned body bytes. Check `truncated`, `bodyReadError`, and `headerErrors` before treating MCP output as complete. `refund_owed` is an obligation, not proof that a refund was sent.

## Library entry point

`import { AgentWallet } from '@voidly/agent-wallet'` provides `create`, `fromPrivateKey`, and `fromSigner`. A wallet instance offers `address`, `receiveInfo()`, `fundingRequest()`, `balance()`, `prepareVoidlySellerRegistration()`, `prepareVoidlySellerListingCreate(payload)`, `payX402()`, `marketplaceAttempts()`, `recoverMarketplace(quoteId)`, and `backupToStore(secret, store)`. The package also exports the file and Relay backup stores, durable spend and attempt stores, and recovery-secret helpers. Library callers must configure the included durable stores or equivalent implementations before paying and must retain their recovery secret outside the package.

With `fromSigner`, seller registration and Marketplace recovery also require an EIP-191 `signMessage` method.

The built-in create and restore paths hold the plaintext key locally; optional Relay backup sends a client-encrypted wallet-key envelope. Relay can associate the backup with its wallet address and authenticated agent account; this path does not send the plaintext wallet key or recovery secret. `fromSigner` uses a caller-supplied signer, whose custody depends on its implementation. Spend caps govern calls made through this wallet only. Seller signing is limited to fixed registration and listing creation mutations; activation remains a separate seller action after upstream health setup.
