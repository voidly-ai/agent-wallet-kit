# Buy a service or list your API

> **Source examples for wallet-kit PR #2.** The 0.2.0 buy/sell CLI is open for review and has not been published. Published `@voidly/agent-wallet@0.1.1` has no buy/sell CLI. These scripts run against the built CLI in this repository and are not included in the npm tarball. For the released JavaScript and local MCP interfaces, use the [0.1.1 setup guide](https://github.com/voidly-ai/agent-wallet-kit/blob/v0.1.1/README.md).

These examples are intended to let an agent select a seller listing, pay for a bounded API call, or register its own API through Voidly's backend. Signing stays with the agent's configured wallet. No browser checkout is part of this path.

The current seller CLI stops at a **pending listing**. Automatic activation is planned backend work, not a capability demonstrated by this draft. Neither a paid result nor a live seller has been demonstrated by running these examples.

## Before starting

- For local source dry runs, build PR #2 as shown below. Use `--pay` or `--submit` only after the CLI release and served backend contract are verified. No 0.2.0 installation command is supplied while publication is pending.
- Except for a `buy` or `sell` dry run, commands require an existing encrypted local wallet and its durable state directory. Supply `VOIDLY_WALLET_RECOVERY_SECRET` from your secret manager. This requirement does not mean that listing or reading attempts makes a payment. See [CLI/API setup](./SETUP.md) for the state boundary.
- Dry runs need no funds. For a later authorized live rehearsal, start on **Base Sepolia** with test funds. Base mainnet requires an explicit `--network base` choice and uses real funds. Every direct CLI command requires `--network`; the wrappers choose Sepolia by default.
- Keep wallet recovery material, spend records and Marketplace attempts across restarts. The kit's caps cover payments sent through its local ledger, not every transaction from the wallet address.

The included wrappers default to dry-run and Base Sepolia. Their `--pay` and `--submit` switches remove `--dry-run` before calling the wallet CLI; they are **wrapper switches, not wallet CLI flags**. The scripts invoke the built CLI with argument arrays and never retry an uncertain operation.

## Run the included dry-run wrappers

Build PR #2 source locally with Node.js 20 or newer: `npm ci && npm run build`. These commands use sample files and perform local validation only:

```sh
node examples/first-service/buy-first-service.mjs --listing-id seller_12345678 --version 1 --input examples/first-service/input.example.json --per-call-usdc 0.10 --daily-usdc 1.00 --max-usdc 0.05
node examples/first-service/sell-first-service.mjs --listing examples/first-service/listing.example.json
```

The buy ID is illustrative. For a real attempt, replace it with an exact live seller ID/version from the selected network catalog, adapt the input to that seller's schema, and review all three caps. Add `--network base` only for an intentional mainnet choice. `--pay` permits one buy; `--submit` permits one seller registration/listing submission and refuses the included template file. Neither wrapper retries. Live actions remain unverified by these examples and require the released CLI and current served backend contract.

## Buyer: validate the request first

1. Read the selected network's public catalog. Choose a `seller` item that is `live`, uses `POST`, and has an exact listing ID and version. The sample ID below is syntax only, not a real listing. This CLI does not accept every first-party x402 resource as a seller listing.
2. Prepare a UTF-8 JSON object matching that listing's input schema. The input file must be a regular file, no larger than 65,536 bytes.
3. Set all three USDC caps. `--per-call-usdc` is the kit's per-call limit; `--daily-usdc` is its local daily limit; `--max-usdc` is the ceiling for this purchase and must be positive and no greater than the per-call limit.
4. From this repository, run `npm ci && npm run build`, then invoke the wrapper without `--pay`. The wrapper calls the local built CLI; the dry run does not contact the gateway.

**Direct CLI syntax for the PR #2 source, not a published package command.** Replace every placeholder with a reviewed value:

```text
voidly-agent-wallet buy <listing-id> --network base-sepolia \
  --version <version> --input <input-file.json> \
  --per-call-usdc <amount> --daily-usdc <amount> --max-usdc <amount> \
  --dry-run
```

A successful dry run validates arguments and local JSON. It does **not** fetch the listing, validate the service's current schema response, restore the wallet, contact the gateway, sign or pay. Its `ready` result is local validation, not service readiness.

### Make the authorized call

After the CLI and backend contract are released and verified, omitting `--dry-run` from the same reviewed command makes the call capable of signing and paying. Keep the selected network, listing version, input and caps fixed for that attempt. Use `--network base` only for an intentional mainnet call.

The candidate fetches the exact seller version, checks the advertised network, USDC asset, recipient and call URL, then passes the request through the wallet's x402 handling and caps. Current HTTP 402 terms control the payment. A catalog entry is not a guaranteed response or a guarantee of answer quality.

Read the JSON result and exit status. Keep the original quote ID and attempt records. `refund_owed` means a refund is owed, not that it has been paid. `bodyComplete: false` means the returned output is incomplete, even if payment may have settled.

### Recover the original attempt

If a payment is uncertain, `doNotRepay` is true, or the response body is incomplete, **do not start a new `buy` for that attempt**. Use the returned `recoveryCommand`, or inspect retained attempts and recover the original quote:

```text
voidly-agent-wallet attempts --network base-sepolia
voidly-agent-wallet recover <original-quote-id> --network base-sepolia
```

These candidate forms also require the matching CLI and the original local state. Use `base` when the original attempt was on mainnet. Recovery may contact the backend; it is not an offline dry run or a fresh purchase. Preserve an `archivePending` result for follow-up instead of treating it as permission to pay again.

## Seller: validate the listing first

Prepare a listing document with `name`, `description`, `category`, a public HTTPS `upstreamUrl`, `method: "POST"`, integer `priceAtomic`, and the supported input/output JSON schemas. `priceAtomic` uses atomic USDC units, not a decimal USDC amount. The included template's URL and price are examples, not a deployed endpoint or live listing.

**Direct CLI syntax for the PR #2 source, awaiting release:**

```text
voidly-agent-wallet sell --network base-sepolia \
  --listing <listing-file.json> --dry-run
```

The seller dry run checks the local listing document. It does not load a wallet, register a provider, submit a listing, check the upstream or prove that the service is buyable.

### Current candidate submission boundary

After release and backend verification, omitting `--dry-run` allows the configured wallet to sign fresh seller challenges and submit registration and listing creation. The candidate expects an active provider on the selected chain and a **pending** listing response.

The CLI writes the one-time health credential to a private file and returns its `secretFile` path. It does not print the HMAC secret. Keep that file out of source control, logs, prompts and public responses. An optional `--secret-file` must name a new file in a private, user-owned directory without symlinks.

`pending_activation` does **not** mean published, indexed or buyable. In the current contract, upstream secret provisioning and signed health/activation remain separate. Use the exact [seller API contract](https://voidly.ai/pay/marketplace/agent-quickstart) for the version being deployed; this draft supplies no improvised HMAC implementation or activation command.

If creation returns `seller_creation_uncertain` or `doNotRetry`, stop and retain its attempt marker. Do not automatically submit another listing. If the CLI reports `seller_secret_persistence_failed`, the listing may exist but its one-time secret was not saved; reconcile the listing and rotate its secret through the supported contract before activation.

## What must change before these examples ship

The intended final flow is machine-complete: an authorized agent lists, completes automatic checks, confirms public visibility and becomes buyable through the released backend contract. This is the target, not the current candidate result.

Before calling these examples released or buyable, the integration owner must:

- Pin a released CLI and its applicable gate result, then add its verified installation command. The source wrapper invocations below are already implemented and tested as local dry runs.
- Match seller output and recovery behavior to the deployed automatic-activation contract. Replace the current pending-activation explanation only when that change is verified.
- Use the capability manifest and MCP discovery contract once they are actually available; neither is assumed live here.
- Verify the listing's exact public version and a bounded buyer read against the deployed contract. A local dry run cannot establish availability or prove a paid outcome.

These repository scripts have offline argument tests and local CLI dry-run checks. No registration, signed purchase, paid delivery, or served activation is established by those checks.
