import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme, getDefaultAsset, type ClientEvmSigner } from '@x402/evm';
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, keccak256, stringToBytes, zeroAddress, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import qrcode from 'qrcode-generator';
import {
  decryptWalletBackup,
  encryptWalletBackup,
  RelayWalletBackupStore,
  type WalletBackupStore,
} from './backup.js';
import {
  type BaseNetwork,
  type SpendLimits,
  type SpendStore,
  usdToAtomic,
  validateSpendLimits,
} from './spend.js';
import { checkedMarketplaceOrigin, MARKETPLACE_ORIGINS, type MarketplaceAttempt, type MarketplaceAttemptStore } from './marketplaceRecovery.js';
import { verifyMarketplaceOutcome } from './marketplaceReceiptVerification.js';
import { prepareVoidlySellerRegistration as prepareSellerRegistration, type PreparedVoidlySellerRegistration } from './sellerRegistration.js';

export * from './backup.js';
export * from './spend.js';
export * from './marketplaceRecovery.js';
export * from './marketplaceReceiptVerification.js';
export type { PreparedVoidlySellerRegistration } from './sellerRegistration.js';

export interface AgentWalletOptions {
  network: BaseNetwork;
  limits: SpendLimits;
  /** A durable local store is required to pay. A memory store is for source-only tests. */
  spendStore?: SpendStore;
  /** Paid Marketplace calls require a durable record before the signed retry is sent. */
  marketplaceAttemptStore?: MarketplaceAttemptStore;
  /** Source-only tests may use an in-memory ledger with inert signer bytes. Never set in production. */
  unsafeAllowVolatileSpendStoreForTests?: boolean;
  /** Maximum time an x402 authorization can remain valid. Defaults to 120 seconds; may only be lowered. */
  maxAuthorizationSeconds?: number;
  rpcUrl?: string;
  fetcher?: typeof fetch;
  /** Optional extra confinement for payment destinations. */
  allowedOrigins?: readonly string[];
  /** Injected for source-only balance tests. */
  balanceReader?: (address: `0x${string}`, network: BaseNetwork) => Promise<bigint>;
}

export interface PayX402Request {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** A call-specific cap may lower the configured per-call limit. */
  maxAmountUsd?: string;
}

/** A signed paid retry was dispatched; the caller must recover, never pay again. */
export class PaymentMayHaveSettledError extends Error {
  readonly paymentMayHaveSettled = true;
  readonly recoverWith: 'wallet_recover_marketplace' | null;

  constructor(readonly quoteId: `0x${string}` | null) {
    super('Paid request outcome is uncertain. Do not pay again; recover the original payment.');
    this.name = 'PaymentMayHaveSettledError';
    this.recoverWith = quoteId ? 'wallet_recover_marketplace' : null;
  }

  toResult(): { paymentMayHaveSettled: true; quoteId: `0x${string}` | null;
    recoverWith: 'wallet_recover_marketplace' | null; message: string } {
    return { paymentMayHaveSettled: true, quoteId: this.quoteId,
      recoverWith: this.recoverWith, message: this.message };
  }
}

const NETWORKS = {
  base: { caip: 'eip155:8453', chain: base, defaultRpc: 'https://mainnet.base.org' },
  'base-sepolia': { caip: 'eip155:84532', chain: baseSepolia, defaultRpc: 'https://sepolia.base.org' },
} as const;
/** Circle-issued USDC, not bridged USDbC. Refuse a changed x402 default asset. */
const FUNDING_USDC = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const;
const MARKETPLACE_CALL_PATH = /^\/v1\/services\/([a-z0-9][a-z0-9_-]{7,63})\/call$/;
const DIGEST = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** x402 v2 wraps extension details in info/schema; legacy quotes were direct. */
function marketplaceIntentInfo(value: unknown): Record<string, unknown> | null {
  if (!plainRecord(value)) return null;
  const wrapped = Object.hasOwn(value, 'info') || Object.hasOwn(value, 'schema');
  if (!wrapped) return value;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'info') ||
    !Object.hasOwn(value, 'schema') || !plainRecord(value.info) ||
    !plainRecord(value.schema)) return null;
  return value.info;
}

function marketplaceListingId(url: URL, network: BaseNetwork): string | null {
  const id = MARKETPLACE_CALL_PATH.exec(url.pathname)?.[1] ?? null;
  if (!id || (url.hostname !== 'voidly.ai' && !url.hostname.endsWith('.voidly.ai'))) return null;
  const origin = checkedMarketplaceOrigin(url.href);
  if (origin === 'https://x402-staging.voidly.ai' && network !== 'base-sepolia') {
    throw new Error('Marketplace staging requires Base Sepolia');
  }
  if (id && url.search !== '') throw new Error('Marketplace calls must start at the unquoted URL');
  return id;
}

function marketplaceCanonicalJson(value: unknown): string {
  let nodes = 0;
  function walk(item: unknown, depth: number): string {
    if (++nodes > 10_000 || depth > 32) throw new Error('Marketplace JSON exceeds canonical limits');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Marketplace JSON has an invalid number');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(part => walk(part, depth + 1)).join(',')}]`;
    if (!item || typeof item !== 'object') throw new Error('Marketplace JSON has an invalid value');
    const entries = Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new Error('Marketplace JSON has an unsafe key');
    }
    return `{${entries.map(([key, part]) => `${JSON.stringify(key)}:${walk(part, depth + 1)}`).join(',')}}`;
  }
  return walk(value, 0);
}

function sha256(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function checkedPaymentUrl(input: string, allowedOrigins?: readonly string[]): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') {
    throw new Error('Payment URL must be public HTTPS on port 443, without credentials or fragment');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname.endsWith('.internal') || !hostname.includes('.')) {
    throw new Error('Payment URL host is not public');
  }
  const version = isIP(hostname);
  if (version === 4) {
    const [a, b, c] = hostname.split('.').map(Number);
    if (a === undefined || b === undefined || c === undefined ||
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) {
      throw new Error('Payment URL host is not public');
    }
  } else if (version === 6) {
    throw new Error('IP-literal payment URLs are unsupported');
  }
  if (allowedOrigins && !allowedOrigins.includes(url.origin)) throw new Error('Payment origin is not allowed');
  return url;
}

export interface FundingRequestOptions {
  /** Optional positive USDC decimal with at most six fractional places. */
  amountUsdc?: string;
  /** Reject a request when the caller expects a different EVM chain. */
  expectedChainId?: number;
}

export interface FundingRequest {
  address: `0x${string}`;
  network: BaseNetwork;
  chainId: number;
  asset: 'USDC';
  tokenAddress: `0x${string}`;
  amountUsdc: string | null;
  amountAtomic: string | null;
  uri: string;
  qrSvg: string;
}

/** Base wallet with a local key or caller-supplied signer; Relay backup sends only encrypted ciphertext. */
export class AgentWallet {
  readonly address: `0x${string}`;
  readonly network: BaseNetwork;
  private readonly signer: ClientEvmSigner;
  readonly #privateKey?: Hex;
  private readonly options: AgentWalletOptions;
  private readonly limitsAtomic: { perCall: bigint; daily: bigint };
  private readonly maxAuthorizationSeconds: number;

  private constructor(signer: ClientEvmSigner, options: AgentWalletOptions, privateKey?: Hex) {
    this.limitsAtomic = validateSpendLimits(options.limits);
    this.maxAuthorizationSeconds = options.maxAuthorizationSeconds ?? 120;
    if (!Number.isInteger(this.maxAuthorizationSeconds) || this.maxAuthorizationSeconds < 1 || this.maxAuthorizationSeconds > 120) {
      throw new Error('Authorization lifetime must be 1–120 seconds');
    }
    if (!Object.hasOwn(NETWORKS, options.network)) throw new Error('Unsupported Base network');
    const allowedOrigins = options.allowedOrigins ??
      (options.network === 'base-sepolia' ? MARKETPLACE_ORIGINS : undefined);
    if (!allowedOrigins?.length) {
      throw new Error('Base mainnet requires an explicit payment origin allowlist');
    }
    for (const origin of allowedOrigins) {
      const checked = checkedPaymentUrl(origin);
      if (checked.origin !== origin) throw new Error('Payment allowlist entries must be HTTPS origins');
    }
    this.signer = signer;
    this.address = signer.address;
    this.network = options.network;
    this.#privateKey = privateKey;
    this.options = { ...options, allowedOrigins: [...allowedOrigins] };
  }

  static create(options: AgentWalletOptions): AgentWallet {
    const privateKey = generatePrivateKey();
    return new AgentWallet(privateKeyToAccount(privateKey), options, privateKey);
  }

  /** For recovery from locally decrypted backup or an agent-controlled key store. */
  static fromPrivateKey(privateKey: Hex, options: AgentWalletOptions): AgentWallet {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid private key');
    return new AgentWallet(privateKeyToAccount(privateKey), options, privateKey);
  }

  /** External signer seam; source-only tests pass inert signature bytes here. */
  static fromSigner(signer: ClientEvmSigner, options: AgentWalletOptions): AgentWallet {
    return new AgentWallet(signer, options);
  }

  receiveInfo(): { address: `0x${string}`; network: BaseNetwork; chainId: number; asset: 'USDC'; tokenAddress: string } {
    const config = NETWORKS[this.network];
    return {
      address: this.address,
      network: this.network,
      chainId: config.chain.id,
      asset: 'USDC',
      tokenAddress: getDefaultAsset(config.caip).asset,
    };
  }

  /** A local EIP-681 request only. The payer's wallet must verify and sign any transfer. */
  async fundingRequest(options: FundingRequestOptions = {}): Promise<FundingRequest> {
    const config = NETWORKS[this.network];
    if (options.expectedChainId !== undefined && options.expectedChainId !== config.chain.id) {
      throw new Error('Funding request chain does not match wallet network');
    }
    const tokenAddress = getAddress(getDefaultAsset(config.caip).asset);
    if (tokenAddress !== FUNDING_USDC[this.network]) {
      throw new Error('Configured USDC asset does not match Circle USDC on this Base network');
    }
    let address: `0x${string}`;
    try { address = getAddress(this.address); }
    catch { throw new Error('Invalid wallet address for funding request'); }
    if (address === zeroAddress) throw new Error('Cannot fund the zero address');

    let amountAtomic: string | null = null;
    let amountUsdc: string | null = null;
    if (options.amountUsdc !== undefined) {
      if (typeof options.amountUsdc !== 'string') throw new Error('Funding amount must be a USDC decimal string');
      const atomic = usdToAtomic(options.amountUsdc);
      if (atomic <= 0n) throw new Error('Funding amount must be positive');
      amountAtomic = atomic.toString();
      amountUsdc = formatUnits(atomic, 6);
    }

    const uri = `ethereum:${tokenAddress}@${config.chain.id}/transfer?address=${address}` +
      (amountAtomic === null ? '' : `&uint256=${amountAtomic}`);
    const qr = qrcode(0, 'M');
    qr.addData(uri, 'Byte');
    qr.make();
    const qrSvg = qr.createSvgTag({ cellSize: 4, margin: 16 }); // Four-module quiet zone.
    return { address, network: this.network, chainId: config.chain.id, asset: 'USDC',
      tokenAddress, amountUsdc, amountAtomic, uri, qrSvg };
  }

  /** Sign only a validated, one-use Voidly seller-registration challenge. Never submits it. */
  async prepareVoidlySellerRegistration(): Promise<PreparedVoidlySellerRegistration> {
    return prepareSellerRegistration({
      network: this.network,
      address: this.address,
      allowedOrigins: this.options.allowedOrigins ?? [],
      signer: this.signer,
      fetcher: this.options.fetcher ?? fetch,
    });
  }

  async balance(): Promise<{ address: `0x${string}`; network: BaseNetwork; usdcAtomic: string; usdc: string }> {
    const config = NETWORKS[this.network];
    const atomic = this.options.balanceReader
      ? await this.options.balanceReader(this.address, this.network)
      : await createPublicClient({ chain: config.chain, transport: http(this.options.rpcUrl ?? config.defaultRpc) })
        .readContract({
          address: getDefaultAsset(config.caip).asset as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [this.address],
        });
    return { address: this.address, network: this.network, usdcAtomic: atomic.toString(), usdc: formatUnits(atomic, 6) };
  }

  async backupToStore(secret: string, store: WalletBackupStore): Promise<void> {
    if (!this.#privateKey) throw new Error('External signer has no local key to back up');
    if (store instanceof RelayWalletBackupStore && store.walletAddress.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error('Relay backup address does not match wallet');
    }
    const envelope = await encryptWalletBackup(this.#privateKey, secret);
    await store.put(envelope);
  }

  static async restoreFromStore(secret: string, store: WalletBackupStore, options: AgentWalletOptions): Promise<AgentWallet> {
    const envelope = await store.get();
    if (!envelope) throw new Error('No encrypted wallet backup found');
    return AgentWallet.fromPrivateKey(await decryptWalletBackup(envelope, secret), options);
  }

  /** Recovery identities are read from durable local state after a restart or lost response. */
  async marketplaceAttempts(): Promise<MarketplaceAttempt[]> {
    const store = this.options.marketplaceAttemptStore;
    if (!store || store.kind !== 'durable' && !this.options.unsafeAllowVolatileSpendStoreForTests) {
      throw new Error('Marketplace attempt store is unavailable');
    }
    return store.list(this.address, NETWORKS[this.network].caip);
  }

  /** Fresh payer-authenticated GET for one retained attempt; never makes another payment. */
  async recoverMarketplace(quoteId: string): Promise<{
    response: Response;
    quoteId: `0x${string}`;
    verifiedStatus: 'delivered' | 'refund_owed';
    archivePending: boolean;
  }> {
    if (!DIGEST.test(quoteId)) throw new Error('Invalid Marketplace quote ID');
    const store = this.options.marketplaceAttemptStore;
    if (!store || store.kind !== 'durable' && !this.options.unsafeAllowVolatileSpendStoreForTests) {
      throw new Error('Marketplace attempt store is unavailable');
    }
    const attempt = await store.get(
      quoteId as `0x${string}`, this.address, NETWORKS[this.network].caip);
    if (!attempt) throw new Error('Marketplace attempt not found in durable state');
    const signer = this.signer as ClientEvmSigner & {
      signMessage?: (input: { message: string }) => Promise<`0x${string}`>;
    };
    if (typeof signer.signMessage !== 'function') {
      throw new Error('Marketplace recovery requires a payer EIP-191 signer');
    }
    const chainId = this.network === 'base-sepolia' ? 84532 : 8453;
    const message = `Voidpay Marketplace recovery v1\nchainId:${chainId}\npaymentKey:${attempt.paymentKey}\nquoteId:${attempt.quoteId}`;
    const signature = await signer.signMessage({ message });
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid Marketplace recovery signature');
    const recoveryUrl = checkedPaymentUrl(
      `${checkedMarketplaceOrigin(attempt.targetUrl)}/v1/services/${attempt.listingId}/quotes/${quoteId}/result`,
      this.options.allowedOrigins,
    ).href;
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(recoveryUrl, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: {
        'x-voidpay-recovery-payment-key': attempt.paymentKey,
        'x-voidpay-recovery-signature': signature,
      },
    });
    const outcome = await verifyMarketplaceOutcome(response, attempt, 'recovery', fetcher);
    try {
      await store.markTerminal(attempt.quoteId, outcome.status, outcome.receipt);
      return { response, quoteId: attempt.quoteId, verifiedStatus: outcome.status, archivePending: false };
    } catch {
      // The signed outcome is already verified. Do not hide it behind a local
      // archive failure; the caller still needs the receipt and original quote.
      return { response, quoteId: attempt.quoteId, verifiedStatus: outcome.status, archivePending: true };
    }
  }

  async payX402(request: PayX402Request): Promise<Response> {
    if (!this.options.spendStore) throw new Error('A durable spend store is required before paying');
    if (this.options.spendStore.kind !== 'durable' && !this.options.unsafeAllowVolatileSpendStoreForTests) {
      throw new Error('Volatile spend store refused; a durable atomic spend store is required');
    }
    const target = checkedPaymentUrl(request.url, this.options.allowedOrigins);
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new Error('Only GET and POST x402 calls are supported');
    if (method === 'GET' && request.body !== undefined) throw new Error('GET payment cannot contain a body');
    const listingId = marketplaceListingId(target, this.network);
    const attemptStore = this.options.marketplaceAttemptStore;
    if (listingId && (!attemptStore ||
      attemptStore.kind !== 'durable' && !this.options.unsafeAllowVolatileSpendStoreForTests)) {
      throw new Error('Marketplace payment requires a durable attempt store');
    }
    const maxAtomic = request.maxAmountUsd === undefined
      ? this.limitsAtomic.perCall
      : usdToAtomic(request.maxAmountUsd);
    if (maxAtomic <= 0n || maxAtomic > this.limitsAtomic.perCall) {
      throw new Error('Call cap must be positive and no higher than configured per-call limit');
    }
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body && Buffer.byteLength(body, 'utf8') > 1_000_000) throw new Error('Request body exceeds 1 MB');
    if (listingId && (method !== 'POST' || !body || Buffer.byteLength(body, 'utf8') > 65_536)) {
      throw new Error('Marketplace payment requires a bounded JSON POST body');
    }
    const requestBodySha256 = listingId && body ? sha256(body) : null;
    const quotedInputSha256 = listingId && body
      ? sha256(marketplaceCanonicalJson(JSON.parse(body))) : null;

    const config = NETWORKS[this.network];
    const asset = getDefaultAsset(config.caip).asset;
    const client = new x402Client()
      .register(config.caip, new ExactEvmScheme(this.signer))
      .setSpendControls({ maxAmountPerPayment: `$${this.options.limits.perCallUsd}` });
    let pendingAttempt: Omit<MarketplaceAttempt, 'paymentKey' | 'createdAt'> | null = null;
    let savedAttempt: MarketplaceAttempt | null = null;

    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      const quote = (() => { try { return checkedPaymentUrl(paymentRequired.resource.url, this.options.allowedOrigins); } catch { return null; } })();
      if (!quote || quote.origin !== target.origin || quote.pathname !== target.pathname) {
        return { abort: true, reason: 'x402 quote resource does not match requested endpoint' };
      }
      const requirements = selectedRequirements;
      if (requirements.scheme !== 'exact' || requirements.network !== config.caip ||
        requirements.asset.toLowerCase() !== asset.toLowerCase() ||
        requirements.extra?.assetTransferMethod === 'permit2' ||
        !/^(?:0|[1-9][0-9]*)$/.test(requirements.amount)) {
        return { abort: true, reason: 'Unsupported x402 payment method, network, asset or amount' };
      }
      if (!Number.isInteger(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds < 1 ||
        requirements.maxTimeoutSeconds > this.maxAuthorizationSeconds) {
        return { abort: true, reason: 'x402 authorization lifetime exceeds local limit' };
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n || amount > maxAtomic) return { abort: true, reason: 'Per-call USDC limit exceeded' };
      if (listingId) {
        if (requirements.extra?.assetTransferMethod !== 'eip3009' ||
          requirements.extra?.paymentFlow !== 'upfront') {
          return { abort: true, reason: 'Marketplace requires upfront EIP-3009 USDC' };
        }
        const quoteId = quote.searchParams.get('quote');
        const intent = marketplaceIntentInfo(paymentRequired.extensions?.['voidpay.intent']);
        if (quote.searchParams.size !== 1 || !quoteId || !DIGEST.test(quoteId) ||
          !intent || intent.version !== 1 || intent.listingId !== listingId ||
          !Number.isSafeInteger(intent.listingVersion) || Number(intent.listingVersion) < 1 ||
          intent.quoteId !== quoteId || intent.resource !== quote.href ||
          intent.inputDigest !== quotedInputSha256 ||
          typeof intent.sellerWallet !== 'string' || !ADDRESS.test(intent.sellerWallet) ||
          intent.sellerWallet.toLowerCase() !== requirements.payTo.toLowerCase() ||
          intent.amountAtomic !== requirements.amount ||
          !ADDRESS.test(requirements.payTo)) {
          return { abort: true, reason: 'Marketplace quote binding is invalid' };
        }
        pendingAttempt = {
          version: 1, wallet: this.address.toLowerCase() as `0x${string}`,
          network: config.caip, asset: asset.toLowerCase() as `0x${string}`,
          payTo: requirements.payTo.toLowerCase() as `0x${string}`,
          amountAtomic: requirements.amount, listingId,
          listingVersion: Number(intent.listingVersion),
          targetUrl: target.href, quoteUrl: quote.href, quoteId: quoteId as `0x${string}`,
          quotedInputSha256: quotedInputSha256!, requestBodySha256: requestBodySha256!,
        };
      }
      try {
        if (listingId) await attemptStore!.ensureCapacity();
        await this.options.spendStore!.reserve({
          wallet: this.address,
          network: this.network,
          amountAtomic: amount,
          dailyLimitAtomic: this.limitsAtomic.daily,
        });
      } catch (error) {
        return { abort: true, reason: error instanceof Error ? error.message : 'Spend ledger unavailable' };
      }
    });

    client.onAfterPaymentCreation(async ({ paymentRequired, selectedRequirements, paymentPayload }) => {
      if (!listingId) return;
      const attempt = pendingAttempt;
      const authorization = paymentPayload.payload?.authorization;
      if (!attempt || paymentPayload.x402Version !== 2 ||
        paymentRequired.resource.url !== attempt.quoteUrl ||
        paymentPayload.resource?.url !== attempt.quoteUrl ||
        paymentPayload.accepted.scheme !== 'exact' ||
        paymentPayload.accepted.network !== attempt.network ||
        paymentPayload.accepted.asset.toLowerCase() !== attempt.asset ||
        paymentPayload.accepted.amount !== selectedRequirements.amount ||
        paymentPayload.accepted.payTo.toLowerCase() !== attempt.payTo ||
        !authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
        throw new Error('Marketplace authorization binding is invalid');
      }
      const payer = (authorization as Record<string, unknown>).from;
      const payee = (authorization as Record<string, unknown>).to;
      const nonce = (authorization as Record<string, unknown>).nonce;
      const value = (authorization as Record<string, unknown>).value;
      if (typeof payer !== 'string' || payer.toLowerCase() !== this.address.toLowerCase() ||
        typeof payee !== 'string' || payee.toLowerCase() !== attempt.payTo ||
        typeof nonce !== 'string' || !DIGEST.test(nonce.toLowerCase()) ||
        String(value) !== attempt.amountAtomic) {
        throw new Error('Marketplace authorization payer, payee, nonce or amount is invalid');
      }
      const paymentKey = keccak256(stringToBytes([
        config.caip, asset.toLowerCase(), payer.toLowerCase(), nonce.toLowerCase(),
      ].join('|')));
      const record: MarketplaceAttempt = { ...attempt, paymentKey, createdAt: new Date().toISOString() };
      await attemptStore!.save(record);
      savedAttempt = record;
      pendingAttempt = null;
    });

    const fetcher = this.options.fetcher ?? fetch;
    let paidRetryStarted = false;
    const guardedFetch: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href !== target.href) throw new Error('x402 retry target changed');
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      if (headers.has('payment-signature')) paidRetryStarted = true;
      return fetcher(input, { ...init, redirect: 'manual' });
    };
    const paidFetch = wrapFetchWithPayment(guardedFetch, client);
    try {
      const response = await paidFetch(target.href, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if (listingId) {
        const completedAttempt = savedAttempt as MarketplaceAttempt | null;
        if (!completedAttempt) throw new Error('Marketplace paid retry lacked a durable attempt record');
        const outcome = await verifyMarketplaceOutcome(response, completedAttempt, 'paid', fetcher);
        await attemptStore!.markTerminal(completedAttempt.quoteId, outcome.status, outcome.receipt);
      }
      return response;
    } catch (error) {
      const uncertainAttempt = savedAttempt as MarketplaceAttempt | null;
      if (paidRetryStarted) throw new PaymentMayHaveSettledError(uncertainAttempt?.quoteId ?? null);
      throw error;
    }
  }
}
