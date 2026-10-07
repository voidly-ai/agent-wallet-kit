# CLI and API setup

> **Setup for the published 0.2.0 CLI and repository examples.** `@voidly/agent-wallet@0.2.0` includes the `voidly-agent-wallet` buy/sell executable. The included wrappers run the built source CLI; local dry runs establish validation only.

## Version and runtime

The published package requires Node.js 20 or newer. Install the exact CLI release in your own project with `npm install --save-exact @voidly/agent-wallet@0.2.0`; its executable is `./node_modules/.bin/voidly-agent-wallet`. To run the repository wrappers, use this checkout and run `npm ci && npm run build` first. The wrapper scripts are not in the npm package.

The command forms below are in the released 0.2.0 client. Angle-bracket values are placeholders, not executable shell input.

| Command | Required input | Effect with no `--dry-run` |
| --- | --- | --- |
| `buy <listing-id>` | `--network`, `--version`, `--input`, `--per-call-usdc`, `--daily-usdc`, `--max-usdc` | Fetches the exact live seller listing, restores the local wallet and attempts one bounded x402 call. |
| `sell` | `--network`, `--listing`; optional `--secret-file` | Signs provider/listing requests and creates a pending listing; stores the one-time health credential privately. |
| `attempts` | `--network` | Restores the wallet and lists retained Marketplace attempt metadata. |
| `recover <quote-id>` | `--network` | Uses the retained original attempt to recover its backend outcome. |

Only the underlying `buy` and `sell` commands accept `--dry-run`. They do not accept `--pay` or `--submit`; those two switches are implemented by the repository wrappers, which omit `--dry-run` for a deliberate live attempt. Unknown or repeated flags are rejected.

## Network selection

Every direct CLI invocation requires an explicit network. Start with testnet:

| CLI value | Network | Client-selected gateway origin |
| --- | --- | --- |
| `base-sepolia` | Base Sepolia, `eip155:84532` | `https://x402-staging.voidly.ai` |
| `base` | Base mainnet, `eip155:8453` | `https://x402.voidly.ai` |

These are source-pinned route choices, not new availability observations. Network, asset, recipient, listing version and payment cap must remain consistent through a purchase. Do not move a quote or attempt record between networks.

## Wallet and durable state

`buy`, `sell`, `attempts` and `recover` restore a wallet already saved as an encrypted local backup; only the `buy` and `sell` dry-run paths skip that step. Restoring a wallet does not itself mean a payment is made. The CLI does not create a new wallet automatically. Follow the matching wallet release's setup guide before funding your own wallet.

| Setting | Meaning |
| --- | --- |
| `VOIDLY_WALLET_RECOVERY_SECRET` | Load the existing backup's recovery secret from a secret manager. Never paste it into a command example, public prompt or repository. |
| `VOIDLY_WALLET_STATE_DIR` | Optional persistent directory for the local wallet state. Preserve the backup, spend ledger and Marketplace attempt records across restarts. |
| Default state path | `$XDG_STATE_HOME/voidly-agent-wallet`; if `XDG_STATE_HOME` is absent, `$HOME/.local/state/voidly-agent-wallet`. |
| `--secret-file` | Optional seller health-credential output path. It must be absolute, new, and inside a private directory owned by the current user with no symlinks. |

Do not choose a temporary state directory for funded use. Recovery needs the original retained attempt; a balance or transaction hash alone is not a substitute for that state. Caps apply to payments routed through the kit's local ledger.

The health credential is separate from the wallet recovery secret. The seller command returns a file path, listing ID/version and health metadata; keep the secret file private while provisioning the upstream through your authorized secret-management path.

## Buyer input and caps

- Listing IDs and versions come from the selected network's actual catalog/detail response. The CLI accepts a `seller` listing with `status: "live"`, `method: "POST"`, and the exact requested version.
- The input must be a regular UTF-8 JSON file, at most 65,536 bytes, containing an object. Prepare it for the selected service's schema. Local dry-run does not fetch or validate the live schema.
- All three cap flags take USDC amounts. `--max-usdc` must be positive and no greater than `--per-call-usdc`; the spend policy separately enforces the configured daily budget.
- Keep a request's listing version, input and caps attached to its original attempt. Do not turn an uncertain result into a new purchase.

## Seller input

The CLI requires `name`, `description`, `category`, `upstreamUrl`, `method`, `priceAtomic`, `inputSchema` and `outputSchema`. Its seller command requires `POST`. The URL must satisfy the public HTTPS restrictions; schemas use the supported constrained subset, not arbitrary JSON Schema features.

Use `listing.example.json` for local validation, then replace its sample endpoint and review its price and schemas before any submission. The seller wrapper refuses the included template file with `--submit`; a copied listing must name your deployed upstream. Your endpoint must be your deployed service. A sample endpoint, valid JSON or successful dry-run is not evidence of health, activation or a sale.

## API contract map

The table records the released client contract and the current public guide. It is not a set of newly tested API calls. Do not construct fresh signature bodies or HMAC handlers from this summary.

| Step | Route or source | Authentication and boundary |
| --- | --- | --- |
| Discover | Public `/v1/services` catalog on the selected gateway | Read descriptive listings; select an exact seller ID and version. |
| Read exact seller | `GET /v1/services/{listing-id}?network={network-id}&version={version}` | Client checks the expected gateway, listing, live state, POST method, Base USDC asset and recipient. |
| Buy | `POST /v1/services/{listing-id}/call` | The wallet's x402 path uses the current 402 terms and its configured limits. This is the payment boundary. |
| Request seller challenge | `POST /v1/providers/challenge` | Client sends wallet, action and payload, validates the returned SIWE message, then signs it locally. |
| Register seller | `POST /v1/providers/register` | Sends the prepared payload/message/signature envelope. Client verifies active provider, wallet and chain. |
| Create listing | `POST /v1/listings` | Uses a new challenge bound to that action/payload. Current client expects pending state and a one-time health credential. |
| Prove health / activate | Exact health URL and `POST /v1/listings/{listing-id}/activate` in the seller guide | Not performed by the current `sell` command. Use the deployed signed-health and expected-version contract; automatic activation remains pending. |
| Recover | Released `attempts` / `recover` commands | Retain the original quote and attempt. Do not substitute a new `buy`. |

Do not substitute the separate direct-pay `/v1/pay/listings` API for the x402 gateway listing contract. A listing on one interface does not establish state on the other.

## Read results before continuing

| Result | Next action |
| --- | --- |
| Dry-run `status: "ready"` | Local validation passed only. No gateway or wallet operation occurred. |
| `pending_activation` | Preserve the seller credential and exact listing version. Do not label the service live or buyable. |
| `seller_creation_uncertain` / `doNotRetry` | Preserve the attempt marker; reconcile through the supported seller contract. Do not repeat creation automatically. |
| `seller_secret_persistence_failed` | Preserve the listing ID; reconcile and rotate the health secret before activation. |
| `doNotRepay`, `bodyComplete: false` or a recovery command | Retain the original payment attempt and recover that quote. Do not pay again. |
| `refund_owed` | Track the owed refund; this status does not prove reimbursement. |
| `archivePending` | Keep local state and follow up on the original attempt; do not infer that another payment is needed. |

The CLI writes successful result JSON to stdout and error JSON to stderr. Exit code 1 is an error; 2 reports `refund_owed`; 3 reports incomplete response output when the result is not already `refund_owed`. A zero exit is not a statement about answer quality or seller revenue.

## Integration note

The CLI is published, but these repository wrappers only demonstrate local validation. Verify the selected network's served seller activation contract and the listing's public status before calling a service buyable. A capability manifest exists in source but has not been verified as served; the `voidly_capabilities` MCP tool is source-only in PR #3, outside published 0.2.0. Do not use guessed URLs or describe either discovery surface as live. Keep the final path machine/API/CLI driven, with buyer-owned signing and no browser approval step.
