import type { BaseNetwork } from './spend.js';

/** An offline guide only: no environment, wallet, filesystem, signing or transport access. */
export function walletQuickstartGuide(network: BaseNetwork): Record<string, unknown> {
  const gateway = network === 'base' ? 'https://x402.voidly.ai' : 'https://x402-staging.voidly.ai';
  const buy = ['voidly-agent-wallet', 'buy', '<LISTING_ID>', '--network', network,
    '--version', '<LISTING_VERSION>', '--input', '<ABSOLUTE_INPUT_JSON>',
    '--per-call-usdc', '<PER_CALL_USDC>', '--daily-usdc', '<DAILY_USDC>', '--max-usdc', '<MAX_USDC>'];
  const sell = ['voidly-agent-wallet', 'sell', '--quickstart', '--network', network,
    '--listing', '<ABSOLUTE_LISTING_JSON>'];
  return {
    schema: 'voidly-wallet-quickstart/v1', command: 'quickstart', mode: 'guide_only',
    package: { name: '@voidly/agent-wallet', version: '0.6.0' }, network, gateway,
    effects: { networkRequests: false, walletAccess: false, fileWrites: false, signing: false, payment: false },
    approval: {
      requiredBeforeExecution: true,
      instruction: 'The user must approve each exact buy or sell operation before the host runs it. Printing this guide is not approval.',
      mainnet: 'Base mainnet requires an explicit network choice and user approval; never execute automatically.',
      mcp: 'Set confirm:true for wallet_buy or wallet_sell_quickstart only after the host obtains user approval. The field acknowledges host approval; it does not authenticate a human.',
    },
    prerequisites: [
      'Node.js 20 or newer and a reviewed wallet package or built source checkout.',
      'An existing encrypted local wallet; retain its full durable state directory across restarts.',
      'Supply VOIDLY_WALLET_RECOVERY_SECRET through the secret manager for CLI execution; never put keys or recovery secrets in argv or JSON inputs.',
      'Replace every <PLACEHOLDER> in the argv templates with reviewed values; this guide does not select a live listing or authorize a budget.',
    ],
    buy: {
      steps: [
        'Select one live seller listing on the selected network; review its exact ID, version, payee, price and input schema.',
        'Save input JSON matching that schema. Choose positive per-call, daily and maximum-price caps; max must not exceed per-call, and per-call must not exceed daily.',
        'Run the local dry run, obtain user approval of the listing, input, network and caps, then execute once.',
        'Inspect verifiedStatus and body completeness. A held, uncertain or incomplete response requires original-attempt recovery, never another buy.',
      ],
      dryRunArgv: [...buy, '--dry-run'], executeAfterApprovalArgv: buy,
      mcp: { tool: 'wallet_buy', requiredArguments: ['listingId', 'version', 'inputFile', 'maxUsdc', 'confirm'],
        requiresConfirmTrue: true, note: 'Uses the loaded wallet and server-configured network, origin allowlist and spend caps. inputFile is absolute.' },
    },
    sell: {
      steps: [
        'Prepare a public HTTPS upstream and save listing JSON; review rights, price, description and input/output schemas.',
        'Run the local dry run, obtain user approval of the exact listing and network, then execute once.',
        'Keep the private intent and HMAC receipt paths. Install the health secret on your upstream without exposing it to prompts, logs or tool output.',
        'A pending listing is not live. Follow the gateway health/activation requirements and verify live state before advertising availability.',
      ],
      listingTemplate: { name: 'Example text service', description: 'Returns a short text response for a prompt.',
        category: 'text', upstreamUrl: 'https://seller.example.com/service', method: 'POST',
        priceAtomic: 10000, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      templateNote: 'Example values only; replace the upstream and schemas with your actual service. 10000 atomic is 0.01 USDC.',
      dryRunArgv: [...sell, '--dry-run'], executeAfterApprovalArgv: sell,
      mcp: { tool: 'wallet_sell_quickstart', requiredArguments: ['listingFile', 'confirm'],
        requiresConfirmTrue: true, note: 'Uses the loaded wallet. listingFile is absolute; optional resumeFile reuses the saved private intent.' },
      recovery: { automaticRetry: false, preserve: ['intentFile', 'secretFile', 'exact listing JSON', 'network'],
        instruction: 'After an uncertain result, explicitly resume the original intent with a fresh challenge. Never allocate a new idempotency key. Reconcile a conflict before retrying.',
        resumeAfterApprovalArgv: [...sell, '--resume-file', '<ORIGINAL_PRIVATE_INTENT_JSON>'] },
    },
    buyerRecovery: {
      heldHttpStatuses: [202, 503], automaticRetry: false, doNotRepay: true,
      instruction: 'A 202/503 receipt hold or any uncertain paid response is not delivery or a refund. Preserve the original quoteId, paymentKey, wallet, network and local attempt; follow its recovery pointer, never rerun buy or authorize a replacement payment.',
      attemptsArgv: ['voidly-agent-wallet', 'attempts', '--network', network],
      recoverOriginalArgv: ['voidly-agent-wallet', 'recover', '<ORIGINAL_QUOTE_ID>', '--network', network],
      mcp: { attemptsTool: 'wallet_marketplace_attempts', recoveryTool: 'wallet_recover_marketplace', argument: 'quoteId' },
      terminalCheck: 'Accept delivery only after signed receipt verification and complete output. refund_owed is an obligation, not a completed refund. If recovery is still held, retain the same identity and wait for explicit reconciliation.',
    },
    surfaces: {
      localWalletMcp: { binary: 'voidly-agent-wallet-mcp', transport: 'stdio', registryName: 'io.github.voidly-ai/agent-wallet-kit' },
      hostedMcp: { url: 'https://api.voidly.ai/mcp', transport: 'streamable-http', registryName: 'io.github.voidly-ai/voidly-hosted' },
      evidence: 'Local wallet package/Registry publication, hosted Registry registration and live route behavior are separate. This offline guide checks none of them.',
    },
  };
}
