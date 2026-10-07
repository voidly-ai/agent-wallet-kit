# Buy a service or list your API

> **Repository examples for the published 0.2.0 CLI.** `@voidly/agent-wallet@0.2.0` includes the `voidly-agent-wallet` buy/sell executable. These wrapper scripts are repository examples and are not included in the npm tarball. They run the CLI built from this checkout; for wallet setup and the published 0.2.0 install command, see the [README in this checkout](../../README.md).

These examples are intended to let an agent select a seller listing, pay for a bounded API call, or register its own API through Voidly's backend. Signing stays with the agent's configured wallet. No browser checkout is part of this path.

The seller CLI stops at a **pending listing**. Automatic activation is planned backend work, not a capability demonstrated by these examples. Neither a paid result nor a live seller has been demonstrated by running them.

## Before starting

- For local source dry runs, build this checkout as shown below. The published CLI can be installed with `npm install --save-exact @voidly/agent-wallet@0.2.0` in your own project. Use the wrappers' `--pay` or `--submit` only after the selected network's served backend contract and your intended action are verified.
- Except for a `buy` or `sell` dry run, commands require an existing encrypted local wallet and its durable state directory. Supply `VOIDLY_WALLET_RECOVERY_SECRET` from your secret manager. This requirement does not mean that listing or reading attempts makes a payment. See [CLI/API setup](./SETUP.md) for the state boundary.
- Dry runs need no funds. For a later authorized live rehearsal, start on **Base Sepolia** with test funds. Base mainnet requires an explicit `--network base` choice and uses real funds. Every direct CLI command requires `--network`; the wrappers choose Sepolia by default.
- Keep wallet recovery material, spend records and Marketplace attempts across restarts. The kit's caps cover payments sent through its local ledger, not every transaction from the wallet address.

The included wrappers default to dry-run and Base Sepolia. Their `--pay` and `--submit` switches remove `--dry-run` before calling the wallet CLI; they are **wrapper switches, not wallet CLI flags**. The scripts invoke the built CLI with argument arrays and never retry an uncertain operation.

## Run the included dry-run wrappers

Build this checkout locally with Node.js 20 or newer: `npm ci && npm run build`. These commands use sample files and perform local validation only:

```sh
node examples/first-service/buy-first-service.mjs --listing-id seller_12345678 --version 1 --input examples/first-service/input.example.json --per-call-usdc 0.10 --daily-usdc 1.00 --max-usdc 0.05
node examples/first-service/sell-first-service.mjs --listing examples/first-service/listing.example.json
```

The buy ID is illustrative. For a real attempt, replace it with an exact live seller ID/version from the selected network catalog, adapt the input to that seller's schema, and review all three caps. Add `--network base` only for an intentional mainnet choice. `--pay` permits one buy; `--submit` permits one seller registration/listing submission and refuses the included template file. Neither wrapper retries. Live actions remain unverified by these examples and require the current served backend contract.

## Buyer: validate the request first

1. Read the selected network's public catalog. Choose a `seller` item that is `live`, uses `POST`, and has an exact listing ID and version. The sample ID below is syntax only, not a real listing. This CLI does not accept every first-party x402 resource as a seller listing.
2. Prepare a UTF-8 JSON object matching that listing's input schema. The input file must be a regular file, no larger than 65,536 bytes.
3. Set all three USDC caps. `--per-call-usdc` is the kit's per-call limit; `--daily-usdc` is its local daily limit; `--max-usdc` is the ceiling for this purchase and must be positive and no greater than the per-call limit.
4. From this repository, run `npm ci && npm run build`, then invoke the wrapper without `--pay`. The wrapper calls the local built CLI; the dry run does not contact the gateway.

**Direct CLI syntax in published 0.2.0.** Replace every placeholder with a reviewed value:

```text
voidly-agent-wallet buy <listing-id> --network base-sepolia \
  --version <version> --input <input-file.json> \
  --per-call-usdc <amount> --daily-usdc <amount> --max-usdc <amount> \
  --dry-run
```

A successful dry run validates arguments and local JSON. It does **not** fetch the listing, validate the service's current schema response, restore the wallet, contact the gateway, sign or pay. Its `ready` result is local validation, not service readiness.

### Make the authorized call

After the selected network's backend contract is verified as served, omitting `--dry-run` from the same reviewed command makes the call capable of signing and paying. Keep the selected network, listing version, input and caps fixed for that attempt. Use `--network base` only for an intentional mainnet call.

The released CLI is designed to fetch the exact seller version, check the advertised network, USDC asset, recipient and call URL, then pass the request through the wallet's x402 handling and caps. Current HTTP 402 terms control the payment. A catalog entry is not a guaranteed response or a guarantee of answer quality.

Read the JSON result and exit status. Keep the original quote ID and attempt records. `refund_owed` means a refund is owed, not that it has been paid. `bodyComplete: false` means the returned output is incomplete, even if payment may have settled.

### Recover the original attempt

If a payment is uncertain, `doNotRepay` is true, or the response body is incomplete, **do not start a new `buy` for that attempt**. Use the returned `recoveryCommand`, or inspect retained attempts and recover the original quote:

```text
voidly-agent-wallet attempts --network base-sepolia
voidly-agent-wallet recover <original-quote-id> --network base-sepolia
```

These released CLI commands require the original local state. Use `base` when the original attempt was on mainnet. Recovery may contact the backend; it is not an offline dry run or a fresh purchase. Preserve an `archivePending` result for follow-up instead of treating it as permission to pay again.

## Seller: validate the listing first

Prepare a listing document with `name`, `description`, `category`, a public HTTPS `upstreamUrl`, `method: "POST"`, integer `priceAtomic`, and the supported input/output JSON schemas. `priceAtomic` uses atomic USDC units, not a decimal USDC amount. The included template's URL and price are examples, not a deployed endpoint or live listing.

**Direct CLI syntax in published 0.2.0:**

```text
voidly-agent-wallet sell --network base-sepolia \
  --listing <listing-file.json> --dry-run
```

The seller dry run checks the local listing document. It does not load a wallet, register a provider, submit a listing, check the upstream or prove that the service is buyable.

### Current submission boundary

After the selected network's backend contract is verified as served, omitting `--dry-run` allows the configured wallet to sign fresh seller challenges and submit registration and listing creation. The released CLI expects an active provider on the selected chain and a **pending** listing response.

The CLI writes the one-time health credential to a private file and returns its `secretFile` path. It does not print the HMAC secret. Keep that file out of source control, logs, prompts and public responses. An optional `--secret-file` must name a new file in a private, user-owned directory without symlinks.

`pending_activation` does **not** mean published, indexed or buyable. In the current client contract, upstream secret provisioning and signed health/activation remain separate. Verify the served [seller API contract](https://voidly.ai/pay/marketplace/agent-quickstart) for the version being deployed; these examples supply no improvised HMAC implementation or activation command.

If creation returns `seller_creation_uncertain` or `doNotRetry`, stop and retain its attempt marker. Do not automatically submit another listing. If the CLI reports `seller_secret_persistence_failed`, the listing may exist but its one-time secret was not saved; reconcile the listing and rotate its secret through the supported contract before activation.

## What remains before a complete seller flow

The intended final flow is machine-complete: an authorized agent lists, completes automatic checks, confirms public visibility and becomes buyable through the deployed backend contract. This is the target, not a result shown by these examples.

Before calling a seller listing live or buyable, the integration owner must:

- Match seller output and recovery behavior to the deployed automatic-activation contract. Replace the current pending-activation explanation only when that change is verified.
- Use the capability manifest for discovery once it is served. The `voidly_capabilities` MCP tool is source-only in PR #3 and is not part of published 0.2.0.
- Verify the listing's exact public version and a bounded buyer read against the deployed contract. A local dry run cannot establish availability or prove a paid outcome.

These repository scripts have offline argument tests and local CLI dry-run checks. No registration, signed purchase, paid delivery, or served activation is established by those checks.
