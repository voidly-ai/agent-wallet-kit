#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AGENT_CLI_USAGE, isAgentCliCommand, runAgentCli } from './agentCli.js';
import { fetchMarketplaceListing } from './buyListing.js';
import {
  AgentWallet, FileMarketplaceAttemptStore, FileSpendStore, LocalWalletBackupStore,
  PaymentMayHaveSettledError, usdToAtomic, validateSpendLimits,
  validateVoidlySellerListingInput, type AgentWalletOptions, type BaseNetwork,
  type SpendLimits, type VoidlySellerListingInput, type VoidlySellerQuickstartInput,
} from './index.js';

const ORIGINS = {
  base: 'https://x402.voidly.ai',
  'base-sepolia': 'https://x402-staging.voidly.ai',
} as const;
const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const SECRET_HEX = /^[0-9a-f]{64}$/;
const QUOTE_ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_FILE_BYTES = 65_536;
const MAX_SELLER_REPLY_BYTES = 16_384;
const MAX_QUICKSTART_REPLY_BYTES = 65_536;
const MAX_PRIVATE_SELLER_BYTES = 131_072;
const QUICKSTART_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const SELLER_DID = /^did:voidly:[1-9A-HJ-NP-Za-km-z]{1,32}$/;

type CliWallet = Pick<AgentWallet, 'address' | 'network' | 'prepareVoidlySellerRegistration' |
  'prepareVoidlySellerListingCreate' | 'prepareVoidlySellerQuickstart' |
  'payX402' | 'marketplaceAttempts' | 'recoverMarketplace'>;

export interface WalletCliDependencies {
  /** Offline test seams. Runtime always uses platform fetch and an encrypted local vault. */
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  restoreWallet?: (input: { network: BaseNetwork; limits: SpendLimits; stateDir: string;
    origin: string; mode: 'sell' | 'buy' | 'recover'; fetcher: typeof fetch }) => Promise<CliWallet>;
}

export class SellerCreationUncertainError extends Error {
  readonly code = 'seller_creation_uncertain';
  readonly doNotRetry = true;
  constructor(readonly secretFile: string) {
    super('Listing creation may have succeeded. Do not retry; keep the attempt marker and seek seller API or operator reconciliation.');
  }
}

export class SellerSecretPersistenceError extends Error {
  readonly code = 'seller_secret_persistence_failed';
  readonly doNotRetry = true;
  constructor(readonly listingId: string, readonly secretFile: string) {
    super('Listing was created but its one-time health secret was not durably saved. Rotate the secret before activation.');
  }
}

export class SellerQuickstartUncertainError extends Error {
  readonly code = 'seller_quickstart_uncertain';
  readonly automaticRetry = false;
  readonly retrySameIntent = true;
  constructor(readonly intentFile: string, readonly secretFile: string) {
    super('Quickstart may have created a pending listing. Keep the private intent; retry explicitly with --resume-file to sign a fresh challenge for the same payload and key. Reconcile a conflict before another attempt.');
  }
}

export class SellerQuickstartSecretPersistenceError extends Error {
  readonly code = 'seller_quickstart_secret_persistence_failed';
  readonly automaticRetry = false;
  readonly retrySameIntent = true;
  constructor(readonly intentFile: string, readonly secretFile: string) {
    super('Quickstart may have succeeded, but its health secret was not durably saved. Keep the private intent and recover with a fresh signed same-intent retry before activating the listing.');
  }
}

export class SellerQuickstartConflictError extends Error {
  readonly code = 'seller_quickstart_conflict';
  readonly automaticRetry = false;
  readonly retrySameIntent = false;
  constructor(readonly intentFile: string) {
    super('Quickstart returned a conflict. Keep the private intent and reconcile the listing; a changed or activated listing cannot return the old health secret.');
  }
}

export class SellerQuickstartExistingIntentError extends Error {
  readonly code = 'seller_quickstart_existing_intent';
  readonly automaticRetry = false;
  readonly retrySameIntent = true;
  constructor(readonly intentFile: string) {
    super('A private quickstart intent already exists for this wallet and listing. Use --resume-file with that intent; do not allocate a new idempotency key.');
  }
}

const USAGE = `${AGENT_CLI_USAGE}

voidly-agent-wallet sell --network base|base-sepolia --listing listing.json [--secret-file /private/path.json] [--dry-run]
voidly-agent-wallet sell --quickstart --network base|base-sepolia --listing listing.json [--did DID] [--secret-file /private/path.json] [--dry-run]
voidly-agent-wallet sell --quickstart --network base|base-sepolia --listing listing.json --resume-file /private/intent.json
voidly-agent-wallet buy <listing-id> --network base|base-sepolia --version N --input input.json --per-call-usdc AMOUNT --daily-usdc AMOUNT --max-usdc AMOUNT [--dry-run]
voidly-agent-wallet attempts --network base|base-sepolia
voidly-agent-wallet recover <quote-id> --network base|base-sepolia

Both commands restore an existing encrypted local wallet with VOIDLY_WALLET_RECOVERY_SECRET.
sell registers the payout wallet and creates a pending listing. --quickstart performs one signed gateway mutation with a durable idempotency intent. Both leave activation separate; health secrets are written only to private files.
buy makes one bounded x402 call. An uncertain paid retry must be recovered with the original quote ID; never run buy again for that attempt.`;

function parse(argv: string[]): { command: 'sell' | 'buy' | 'attempts' | 'recover' | 'help'; positional: string[]; flags: Map<string, string> } {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    return { command: 'help', positional: [], flags: new Map() };
  }
  const command = argv[0];
  if (command !== 'sell' && command !== 'buy' && command !== 'attempts' && command !== 'recover') throw new Error(USAGE);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const allowed = command === 'sell'
    ? new Set(['network', 'listing', 'secret-file', 'dry-run', 'quickstart', 'resume-file', 'did'])
    : command === 'buy'
      ? new Set(['network', 'version', 'input', 'per-call-usdc', 'daily-usdc', 'max-usdc', 'dry-run'])
      : new Set(['network']);
  for (let i = 1; i < argv.length; i++) {
    const part = argv[i]!;
    if (!part.startsWith('--')) { positional.push(part); continue; }
    const key = part.slice(2);
    if (!allowed.has(key) || flags.has(key)) throw new Error(`Unknown or repeated option: ${part}`);
    if (key === 'dry-run' || key === 'quickstart') { flags.set(key, '1'); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${part}`);
    flags.set(key, value);
  }
  if (command === 'sell' && positional.length !== 0 || command === 'buy' && positional.length !== 1 ||
    command === 'attempts' && positional.length !== 0 || command === 'recover' && positional.length !== 1) {
    throw new Error(USAGE);
  }
  if (command === 'sell' && (!flags.has('quickstart') && (flags.has('resume-file') || flags.has('did')) ||
      flags.has('dry-run') && flags.has('resume-file'))) throw new Error(USAGE);
  return { command, positional, flags };
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function networkFlag(flags: Map<string, string>): BaseNetwork {
  const network = required(flags, 'network');
  if (network !== 'base' && network !== 'base-sepolia') throw new Error('--network must be base or base-sepolia');
  return network;
}

function stateDirectory(env: NodeJS.ProcessEnv): string {
  return env.VOIDLY_WALLET_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'voidly-agent-wallet');
}

async function jsonFile(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    throw new Error('JSON input must be a regular file of at most 65,536 bytes');
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('JSON input is too large');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Input file must contain valid UTF-8 JSON'); }
}

async function defaultRestore(input: { network: BaseNetwork; limits: SpendLimits;
  stateDir: string; origin: string; mode: 'sell' | 'buy' | 'recover'; fetcher: typeof fetch },
  env: NodeJS.ProcessEnv): Promise<CliWallet> {
  const secret = env.VOIDLY_WALLET_RECOVERY_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 16) {
    throw new Error('VOIDLY_WALLET_RECOVERY_SECRET must be loaded from your secret manager');
  }
  const spendStore = input.mode === 'buy' ? new FileSpendStore(input.stateDir) : undefined;
  const options: AgentWalletOptions = {
    network: input.network, limits: input.limits, allowedOrigins: [input.origin],
    spendStore,
    marketplaceAttemptStore: input.mode !== 'sell' ? new FileMarketplaceAttemptStore(input.stateDir) : undefined,
    fetcher: input.fetcher,
  };
  const wallet = await AgentWallet.restoreFromStore(secret, new LocalWalletBackupStore(input.stateDir), options);
  if (spendStore) await spendStore.initialize(wallet.address, input.network, true);
  return wallet;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function privateSellerParent(path: string, createParent: boolean): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Seller private file path must be absolute');
  const parent = dirname(path);
  if (createParent) {
    try { await mkdir(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
    await realpath(parent) !== resolve(parent)) {
    throw new Error('Seller secret directory must be private, owned by this user, and contain no symlinks');
  }
  if (createParent) await syncDirectory(dirname(parent));
  return parent;
}

async function privateSecretFile(path: string, createParent: boolean): Promise<FileHandle> {
  await privateSellerParent(path, createParent);
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) {
    throw new Error('Response exceeds the size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 10_000;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('Response body timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Response body timed out')), remainingMs);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds the size limit');
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, size);
}

async function sellerJson(response: Response, expectedUrl: string, expectedStatus: number,
  maxBytes = MAX_SELLER_REPLY_BYTES): Promise<Record<string, unknown>> {
  if (response.status !== expectedStatus || response.redirected || response.url && response.url !== expectedUrl ||
    !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`Seller endpoint did not return the expected response (HTTP ${response.status})`);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    await readBoundedBytes(response, maxBytes))); }
  catch { throw new Error('Seller endpoint returned invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Seller endpoint returned an invalid result');
  }
  return value as Record<string, unknown>;
}

async function postSeller(fetcher: typeof fetch, url: string, body: unknown, status: number): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return sellerJson(response, url, status);
}

type QuickstartIntent = {
  version: 1; network: BaseNetwork; gateway: string; sellerWallet: string;
  idempotencyKey: string; keySha256: string; listingSha256: string; payloadSha256: string;
  did: string | null; secretFile: string; createdAt: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function quickstartPayload(key: string, listing: VoidlySellerListingInput, did: string | null): VoidlySellerQuickstartInput {
  return { idempotencyKey: key, listing, ...(did ? { did } : {}) };
}

async function readPrivateSellerJson(path: string): Promise<Record<string, unknown>> {
  await privateSellerParent(path, false);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 ||
      before.size > MAX_PRIVATE_SELLER_BYTES || (before.mode & 0o077) !== 0 ||
      typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error('Seller private file must be an owner-only regular file');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const after = await file.stat();
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1 ||
        (after.mode & 0o077) !== 0 || after.size < 1 || after.size > MAX_PRIVATE_SELLER_BYTES) {
      throw new Error('Seller private file changed during read');
    }
    bytes = await file.readFile();
  } finally { await file.close(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Seller private file is invalid JSON'); }
  if (!record(value)) throw new Error('Seller private file is invalid');
  return value;
}

async function writePrivateSellerJson(path: string, value: unknown, createParent: boolean): Promise<void> {
  const file = await privateSecretFile(path, createParent);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally { await file.close(); }
  await syncDirectory(dirname(path));
}

async function privateFileExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isPrivatePartialSellerFile(path: string): Promise<boolean> {
  await privateSellerParent(path, false);
  const file = await lstat(path);
  return file.isFile() && !file.isSymbolicLink() && file.nlink === 1 &&
    file.size <= MAX_PRIVATE_SELLER_BYTES && (file.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || file.uid === process.getuid());
}

function checkedQuickstartIntent(value: Record<string, unknown>, network: BaseNetwork, origin: string,
  listing: VoidlySellerListingInput, selectedDid: string | undefined,
  selectedSecretFile: string | undefined): QuickstartIntent {
  const keys = ['version', 'network', 'gateway', 'sellerWallet', 'idempotencyKey', 'keySha256',
    'listingSha256', 'payloadSha256', 'did', 'secretFile', 'createdAt'];
  const key = value.idempotencyKey;
  const did = value.did;
  const expectedPayload = typeof key === 'string' && QUICKSTART_KEY.test(key) &&
    (did === null || typeof did === 'string' && SELLER_DID.test(did))
    ? quickstartPayload(key, listing, did) : null;
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
      value.version !== 1 || value.network !== network || value.gateway !== origin ||
      typeof value.sellerWallet !== 'string' || !ADDRESS.test(value.sellerWallet) ||
      !expectedPayload || value.keySha256 !== sha256(key as string) ||
      value.listingSha256 !== sha256(JSON.stringify(listing)) ||
      value.payloadSha256 !== sha256(JSON.stringify(expectedPayload)) ||
      typeof value.secretFile !== 'string' || !isAbsolute(value.secretFile) ||
      selectedSecretFile !== undefined && selectedSecretFile !== value.secretFile ||
      selectedDid !== undefined && selectedDid !== did ||
      typeof value.createdAt !== 'string') {
    throw new Error('Quickstart intent conflicts with the listing, network, DID, or secret path; reconcile before retry');
  }
  return value as QuickstartIntent;
}

function checkedQuickstartResult(value: Record<string, unknown>, listingInput: VoidlySellerListingInput,
  walletAddress: string, network: BaseNetwork): { listingId: string; version: number; keyVersion: number } {
  const provider = value.provider;
  const listing = value.listing;
  const upstream = value.upstreamContract;
  const chainId = network === 'base' ? 8453 : 84532;
  if (!record(provider) || !record(listing) || !record(upstream) ||
      typeof value.hmacSecretHex !== 'string' || !SECRET_HEX.test(value.hmacSecretHex) ||
      provider.status !== 'active' || provider.chainId !== chainId ||
      typeof provider.wallet !== 'string' || provider.wallet.toLowerCase() !== walletAddress.toLowerCase() ||
      typeof listing.id !== 'string' || !LISTING_ID.test(listing.id) ||
      listing.version !== 1 || listing.status !== 'pending' || listing.healthState !== 'unchecked' ||
      listing.healthCheckedAt !== null || listing.healthFailureCode !== null ||
      listing.chainId !== chainId || typeof listing.providerWallet !== 'string' ||
      listing.providerWallet.toLowerCase() !== walletAddress.toLowerCase() ||
      listing.name !== listingInput.name || listing.description !== listingInput.description ||
      listing.category !== listingInput.category || listing.upstreamUrl !== listingInput.upstreamUrl ||
      listing.method !== listingInput.method || listing.priceAtomic !== listingInput.priceAtomic ||
      listing.outputPrivacy !== (listingInput.outputPrivacy ?? 'plain-json') ||
      !isDeepStrictEqual(listing.tags, listingInput.tags ?? []) ||
      !isDeepStrictEqual(listing.inputSchema, listingInput.inputSchema) ||
      !isDeepStrictEqual(listing.outputSchema, listingInput.outputSchema) ||
      upstream.url !== listingInput.upstreamUrl ||
      upstream.secretEncoding !== '32-byte key, lowercase hex; HMAC-SHA256 signatures are lowercase hex' ||
      !record(upstream.health) || !record(upstream.health.requestHeaders) ||
      upstream.health.method !== 'GET' || upstream.health.keyVersion !== 1 ||
      upstream.health.requestHeaders['X-Voidpay-Health-Listing'] !== listing.id ||
      !record(upstream.paidCall) || upstream.paidCall.method !== listingInput.method ||
      !record(upstream.activation) || upstream.activation.path !== `/v1/listings/${listing.id}/activate` ||
      upstream.activation.action !== 'listing_activate') {
    throw new Error('Quickstart response conflicts with the signed listing or health contract');
  }
  return { listingId: listing.id, version: 1, keyVersion: 1 };
}

function checkedQuickstartReceipt(receipt: Record<string, unknown>, intent: QuickstartIntent,
  intentFile: string, network: BaseNetwork, origin: string): string {
  if (receipt.intentFile !== intentFile || receipt.keySha256 !== intent.keySha256 ||
      receipt.network !== network || receipt.gateway !== origin ||
      receipt.sellerWallet !== intent.sellerWallet ||
      typeof receipt.listingId !== 'string' || !LISTING_ID.test(receipt.listingId) ||
      receipt.listingVersion !== 1 || typeof receipt.hmacSecretHex !== 'string' ||
      !SECRET_HEX.test(receipt.hmacSecretHex)) {
    throw new Error('Existing quickstart receipt conflicts with the private intent; reconcile before retry');
  }
  return receipt.listingId;
}

async function runQuickstartSell(input: {
  network: BaseNetwork; origin: string; listing: VoidlySellerListingInput;
  stateDir: string; flags: Map<string, string>; fetcher: typeof fetch; restore: () => Promise<CliWallet>;
}): Promise<Record<string, unknown>> {
  const { network, origin, listing, stateDir, flags, fetcher, restore } = input;
  const selectedDid = flags.get('did');
  if (selectedDid !== undefined && !SELLER_DID.test(selectedDid)) throw new Error('Invalid seller DID');
  const resumeFile = flags.get('resume-file');
  const listingHash = sha256(JSON.stringify(listing));
  let intentFile: string;
  let intent: QuickstartIntent;
  let wallet: CliWallet | undefined;
  if (resumeFile !== undefined) {
    if (!isAbsolute(resumeFile)) throw new Error('--resume-file must be an absolute private path');
    intentFile = resumeFile;
    intent = checkedQuickstartIntent(await readPrivateSellerJson(intentFile), network, origin,
      listing, selectedDid, flags.get('secret-file'));
  } else {
    wallet = await restore();
    if (wallet.network !== network) throw new Error('Restored wallet network differs from --network');
    const sellerWallet = wallet.address.toLowerCase();
    if (!ADDRESS.test(sellerWallet)) throw new Error('Restored wallet address is invalid');
    const did = selectedDid ?? null;
    const intentName = sha256(`${network}\n${sellerWallet}\n${listingHash}`);
    intentFile = join(stateDir, 'seller-quickstart', `${intentName}.intent.json`);
    await privateSellerParent(intentFile, true);
    if (await privateFileExists(intentFile)) throw new SellerQuickstartExistingIntentError(intentFile);
    const secretFile = flags.get('secret-file') ?? intentFile.replace(/\.intent\.json$/, '.secret.json');
    await privateSellerParent(secretFile, false);
    if (await privateFileExists(secretFile)) throw new Error('Quickstart secret path already exists');
    const idempotencyKey = randomBytes(24).toString('base64url');
    const payload = quickstartPayload(idempotencyKey, listing, did);
    intent = { version: 1, network, gateway: origin, sellerWallet, idempotencyKey,
      keySha256: sha256(idempotencyKey), listingSha256: listingHash,
      payloadSha256: sha256(JSON.stringify(payload)), did, secretFile,
      createdAt: new Date().toISOString() };
    await writePrivateSellerJson(intentFile, intent, false);
  }
  const secretFile = intent.secretFile;
  await privateSellerParent(secretFile, false);
  let receiptFile = secretFile;
  if (resumeFile !== undefined) {
    // Preserve partial private receipts after a failed write. Explicit resume uses the
    // same signed intent and writes recovery into the first unused private path.
    for (let recoveryIndex = 0; recoveryIndex <= 8; recoveryIndex++) {
      if (!await privateFileExists(receiptFile)) break;
      let receipt: Record<string, unknown>;
      try { receipt = await readPrivateSellerJson(receiptFile); }
      catch (error) {
        if (!await isPrivatePartialSellerFile(receiptFile)) throw error;
        if (recoveryIndex === 8) throw new Error('Quickstart private recovery receipt limit reached; reconcile the intent');
        receiptFile = `${secretFile}.recovery-${String(recoveryIndex + 1).padStart(2, '0')}.json`;
        continue;
      }
      const listingId = checkedQuickstartReceipt(receipt, intent, intentFile, network, origin);
      return { command: 'sell', quickstart: true, status: 'pending_activation', network, gateway: origin,
        sellerWallet: intent.sellerWallet, listingId, version: 1,
        intentFile, secretFile: receiptFile,
        next: 'Install the private HMAC secret on the upstream, then perform separate health and activation steps.' };
    }
  } else if (await privateFileExists(secretFile)) {
    throw new Error('Quickstart secret path already exists');
  }
  wallet ??= await restore();
  if (wallet.network !== network || wallet.address.toLowerCase() !== intent.sellerWallet) {
    throw new Error('Restored wallet does not match the private quickstart intent');
  }
  const payload = quickstartPayload(intent.idempotencyKey, listing, intent.did);
  const prepared = await wallet.prepareVoidlySellerQuickstart(payload);
  const submitUrl = `${origin}/v1/sellers/quickstart`;
  if (prepared.submitUrl !== submitUrl || !isDeepStrictEqual(prepared.body.payload, payload)) {
    throw new Error('Seller quickstart target or signed payload changed');
  }
  let created: Record<string, unknown>;
  let verified: { listingId: string; version: number; keyVersion: number };
  try {
    const response = await fetcher(submitUrl, {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(prepared.body),
    });
    if (response.status === 409) throw new SellerQuickstartConflictError(intentFile);
    created = await sellerJson(response, submitUrl, 201, MAX_QUICKSTART_REPLY_BYTES);
    verified = checkedQuickstartResult(created, listing, wallet.address, network);
  } catch (error) {
    if (error instanceof SellerQuickstartConflictError) throw error;
    throw new SellerQuickstartUncertainError(intentFile, receiptFile);
  }
  const receipt = { version: 1, network, gateway: origin, sellerWallet: intent.sellerWallet,
    intentFile, keySha256: intent.keySha256, listingId: verified.listingId,
    listingVersion: verified.version, hmacSecretHex: created.hmacSecretHex,
    upstreamContract: created.upstreamContract, createdAt: new Date().toISOString() };
  try { await writePrivateSellerJson(receiptFile, receipt, false); }
  catch { throw new SellerQuickstartSecretPersistenceError(intentFile, receiptFile); }
  return { command: 'sell', quickstart: true, status: 'pending_activation', network, gateway: origin,
    listingId: verified.listingId, version: verified.version, sellerWallet: intent.sellerWallet,
    intentFile, secretFile: receiptFile, healthUrl: listing.upstreamUrl, healthKeyVersion: verified.keyVersion,
    next: 'Install the private HMAC secret on the upstream, then perform separate health and activation steps.' };
}

async function paidResponse(response: Response, verifiedStatus: 'delivered' | 'refund_owed',
  network: BaseNetwork): Promise<Record<string, unknown>> {
  let receipt: string | null = null;
  let quoteId: string | null = null;
  const base = { httpStatus: response.status, receiptVerified: true, verifiedStatus,
    refundOwed: verifiedStatus === 'refund_owed', doNotRepay: true };
  try {
    receipt = response.headers.get('x-voidpay-delivery-receipt');
    const paymentResponse = response.headers.get('payment-response');
    if (receipt && receipt.length <= 16_384) {
      const value: unknown = JSON.parse(Buffer.from(receipt, 'base64url').toString('utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const candidate = (value as Record<string, unknown>).quoteId;
        if (typeof candidate === 'string' && QUOTE_ID.test(candidate)) quoteId = candidate;
      }
    }
    const recoveryCommand = quoteId
      ? `voidly-agent-wallet recover ${quoteId} --network ${network}`
      : `voidly-agent-wallet attempts --network ${network}`;
    if (receipt && receipt.length > 16_384 || paymentResponse && paymentResponse.length > 16_384) {
      return { ...base, quoteId, bodyComplete: false, recoveryCommand,
        recoveryHint: 'Paid response metadata exceeded the limit. Preserve the original Marketplace attempt.' };
    }
    const bytes = await readBoundedBytes(response, 1_000_000);
    let bodyUtf8: string | null;
    try { bodyUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { bodyUtf8 = null; }
    return { ...base, quoteId, receipt, paymentResponse,
      bodyUtf8, bodyBase64: bodyUtf8 === null ? bytes.toString('base64') : undefined,
      bodyComplete: true, recoveryCommand };
  } catch {
    return { ...base, quoteId, receipt: receipt && receipt.length <= 16_384 ? receipt : null,
      bodyComplete: false,
      recoveryCommand: quoteId
        ? `voidly-agent-wallet recover ${quoteId} --network ${network}`
        : `voidly-agent-wallet attempts --network ${network}`,
      recoveryHint: 'Paid response output is incomplete. Preserve the original Marketplace attempt.' };
  }
}

/** One CLI invocation; tests inject inert wallets and transport, never real payments. */
export async function runWalletCli(argv: string[], dependencies: WalletCliDependencies = {}): Promise<Record<string, unknown>> {
  if (isAgentCliCommand(argv[0])) return runAgentCli(argv, dependencies);
  const { command, positional, flags } = parse(argv);
  if (command === 'help') return { usage: USAGE };
  const network = networkFlag(flags);
  const origin = ORIGINS[network];
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetcher ?? fetch;
  const stateDir = stateDirectory(env);
  const restore = dependencies.restoreWallet ?? (input => defaultRestore(input, env));

  if (command === 'attempts' || command === 'recover') {
    const quoteId = command === 'recover' ? positional[0]! : null;
    if (quoteId !== null && !QUOTE_ID.test(quoteId)) throw new Error('Invalid Marketplace quote ID');
    const wallet = await restore({ network, limits: { perCallUsd: '1', dailyUsd: '1' },
      stateDir, origin, mode: 'recover', fetcher });
    if (wallet.network !== network) throw new Error('Restored wallet network differs from --network');
    if (command === 'attempts') {
      const attempts = await wallet.marketplaceAttempts();
      return { command, network, attempts: attempts.map(attempt => ({
        quoteId: attempt.quoteId, listingId: attempt.listingId,
        listingVersion: attempt.listingVersion, createdAt: attempt.createdAt,
      })) };
    }
    const recovered = await wallet.recoverMarketplace(quoteId!);
    return { command, network, archivePending: recovered.archivePending,
      ...(await paidResponse(recovered.response, recovered.verifiedStatus, network)),
      quoteId: recovered.quoteId };
  }

  if (command === 'sell') {
    const payload = validateVoidlySellerListingInput(await jsonFile(required(flags, 'listing')));
    if (payload.method !== 'POST') throw new Error('CLI seller listings must use POST');
    if (flags.has('quickstart')) {
      const selectedDid = flags.get('did');
      if (selectedDid !== undefined && !SELLER_DID.test(selectedDid)) throw new Error('Invalid seller DID');
      if (flags.has('dry-run')) return { command, quickstart: true, network, gateway: origin,
        status: 'ready', name: payload.name, priceAtomic: payload.priceAtomic,
        upstreamUrl: payload.upstreamUrl,
        effect: 'One signed gateway quickstart mutation creates a pending listing; no signing, key allocation, wallet restore, or network request in this dry run.' };
      return runQuickstartSell({ network, origin, listing: payload, stateDir, flags, fetcher,
        restore: () => restore({ network, limits: { perCallUsd: '1', dailyUsd: '1' },
          stateDir, origin, mode: 'sell', fetcher }) });
    }
    if (flags.has('dry-run')) {
      return { command, network, gateway: origin, status: 'ready', name: payload.name,
        priceAtomic: payload.priceAtomic, upstreamUrl: payload.upstreamUrl,
        effect: 'Registration and pending listing creation only; no signing or network request in this dry run.' };
    }
    const secretPath = flags.get('secret-file') ?? join(stateDir, 'seller-secrets', `${randomUUID()}.json`);
    const secretFile = await privateSecretFile(secretPath, !flags.has('secret-file'));
    let createDispatched = false;
    let createdListingId: string | null = null;
    let output: Record<string, unknown> | undefined;
    let failure: unknown;
    try {
      const wallet = await restore({ network, limits: { perCallUsd: '1', dailyUsd: '1' },
        stateDir, origin, mode: 'sell', fetcher });
      if (wallet.network !== network) throw new Error('Restored wallet network differs from --network');
      const registration = await wallet.prepareVoidlySellerRegistration();
      if (registration.submitUrl !== `${origin}/v1/providers/register`) throw new Error('Seller registration target changed');
      const registered = await postSeller(fetcher, registration.submitUrl, registration.body, 200);
      const provider = registered.provider as Record<string, unknown> | undefined;
      if (!provider || provider.status !== 'active' ||
        typeof provider.wallet !== 'string' || provider.wallet.toLowerCase() !== wallet.address.toLowerCase() ||
        provider.chainId !== (network === 'base' ? 8453 : 84532)) {
        throw new Error('Seller registration was not verified');
      }
      const prepared = await wallet.prepareVoidlySellerListingCreate(payload);
      if (prepared.submitUrl !== `${origin}/v1/listings`) throw new Error('Seller listing target changed');
      createDispatched = true;
      let created: Record<string, unknown>;
      try { created = await postSeller(fetcher, prepared.submitUrl, prepared.body, 201); }
      catch { throw new SellerCreationUncertainError(secretPath); }
      const listing = created.listing as Record<string, unknown> | undefined;
      const health = created.health as Record<string, unknown> | undefined;
      if (!listing || !health || typeof listing.id !== 'string' || !LISTING_ID.test(listing.id) ||
        !Number.isSafeInteger(listing.version) || Number(listing.version) < 1 ||
        listing.status !== 'pending' || typeof listing.providerWallet !== 'string' ||
        listing.providerWallet.toLowerCase() !== wallet.address.toLowerCase() ||
        listing.chainId !== (network === 'base' ? 8453 : 84532) ||
        listing.name !== payload.name || listing.description !== payload.description ||
        listing.category !== payload.category || listing.upstreamUrl !== payload.upstreamUrl ||
        listing.method !== payload.method || listing.priceAtomic !== payload.priceAtomic ||
        typeof created.hmacSecretHex !== 'string' || !SECRET_HEX.test(created.hmacSecretHex) ||
        health.method !== 'GET' || health.url !== payload.upstreamUrl ||
        !Number.isSafeInteger(health.keyVersion) || Number(health.keyVersion) < 1) {
        throw new SellerCreationUncertainError(secretPath);
      }
      createdListingId = listing.id;
      const credential = {
        version: 1, gateway: origin, network, sellerWallet: wallet.address,
        listingId: listing.id, listingVersion: listing.version,
        hmacSecretHex: created.hmacSecretHex, health,
        createdAt: new Date().toISOString(),
      };
      try {
        await secretFile.writeFile(JSON.stringify(credential));
        await secretFile.sync();
        await syncDirectory(dirname(secretPath));
      }
      catch { throw new SellerSecretPersistenceError(listing.id, secretPath); }
      output = { command, status: 'pending_activation', network, gateway: origin,
        listingId: listing.id, version: listing.version, sellerWallet: wallet.address,
        secretFile: secretPath, healthUrl: health.url, healthKeyVersion: health.keyVersion,
        next: 'Install the HMAC secret on the upstream and complete the separate listing activation health check.' };
    } catch (error) { failure = error; }
    try { await secretFile.close(); }
    catch (error) {
      if (!failure) failure = createdListingId
        ? new SellerSecretPersistenceError(createdListingId, secretPath)
        : createDispatched ? new SellerCreationUncertainError(secretPath) : error;
    }
    if (!createDispatched) await unlink(secretPath).catch(() => undefined);
    if (failure) throw failure;
    return output!;
  }

  const listingId = positional[0]!;
  if (!LISTING_ID.test(listingId)) throw new Error('Invalid listing ID');
  const version = Number(required(flags, 'version'));
  if (!Number.isSafeInteger(version) || version < 1 || String(version) !== flags.get('version')) {
    throw new Error('--version must be a positive integer');
  }
  const limits = { perCallUsd: required(flags, 'per-call-usdc'), dailyUsd: required(flags, 'daily-usdc') };
  const limitAtomic = validateSpendLimits(limits);
  const maxUsd = required(flags, 'max-usdc');
  const maxAtomic = usdToAtomic(maxUsd);
  if (maxAtomic <= 0n || maxAtomic > limitAtomic.perCall) {
    throw new Error('--max-usdc must be positive and no higher than --per-call-usdc');
  }
  const body = await jsonFile(required(flags, 'input'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Buyer input must be a JSON object');
  if (flags.has('dry-run')) {
    return { command, status: 'ready', network, listingId, version,
      detailUrl: `${origin}/v1/services/${listingId}?network=${network === 'base' ? 'eip155:8453' : 'eip155:84532'}&version=${version}`,
      perCallUsd: limits.perCallUsd, dailyUsd: limits.dailyUsd, maxUsd,
      effect: 'No listing fetch, wallet signing, or payment in this dry run.' };
  }
  const listing = await fetchMarketplaceListing(listingId, version, network, fetcher);
  if (BigInt(listing.priceUsdcAtomic) > maxAtomic) {
    throw new Error('Listed price exceeds your --max-usdc cap');
  }
  const wallet = await restore({ network, limits, stateDir, origin, mode: 'buy', fetcher });
  if (wallet.network !== network) throw new Error('Restored wallet network differs from --network');
  const response = await wallet.payX402({ url: listing.callUrl, method: 'POST', body,
    maxAmountUsd: maxUsd,
    expectedMarketplace: { listingId: listing.id, version: listing.version, payTo: listing.payTo } });
  const verifiedStatus = response.status === 502 ? 'refund_owed' : 'delivered';
  return { command, listingId, version, network, priceUsdcAtomic: listing.priceUsdcAtomic,
    ...(await paidResponse(response, verifiedStatus, network)) };
}

function errorResult(error: unknown, argv: string[]): Record<string, unknown> {
  if (error instanceof PaymentMayHaveSettledError) {
    const index = argv.indexOf('--network');
    const network = argv[index + 1];
    const recoveryCommand = network === 'base' || network === 'base-sepolia'
      ? error.quoteId
        ? `voidly-agent-wallet recover ${error.quoteId} --network ${network}`
        : `voidly-agent-wallet attempts --network ${network}`
      : null;
    return { error: error.message, ...error.toResult(), doNotRepay: true, recoveryCommand };
  }
  if (error instanceof SellerQuickstartUncertainError ||
      error instanceof SellerQuickstartSecretPersistenceError) {
    return { error: error.message, code: error.code, intentFile: error.intentFile,
      secretFile: error.secretFile, automaticRetry: false, retrySameIntent: true };
  }
  if (error instanceof SellerQuickstartConflictError) {
    return { error: error.message, code: error.code, intentFile: error.intentFile,
      automaticRetry: false, retrySameIntent: false };
  }
  if (error instanceof SellerQuickstartExistingIntentError) {
    return { error: error.message, code: error.code, intentFile: error.intentFile,
      automaticRetry: false, retrySameIntent: true };
  }
  if (error instanceof SellerCreationUncertainError) {
    return { error: error.message, code: error.code, secretFile: error.secretFile, doNotRetry: true };
  }
  if (error instanceof SellerSecretPersistenceError) {
    return { error: error.message, code: error.code, listingId: error.listingId,
      secretFile: error.secretFile, doNotRetry: true };
  }
  return { error: error instanceof Error ? error.message : 'Wallet CLI failed' };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const result = await runWalletCli(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (isAgentCliCommand(argv[0]) && typeof result.status === 'string' &&
        result.status !== 'ready' && result.status !== 'accepted') {
      process.exitCode = result.status === 'outcome_unknown' ? 3 : 1;
    } else if (result.verifiedStatus === 'refund_owed') process.exitCode = 2;
    else if (result.bodyComplete === false) process.exitCode = 3;
  } catch (error) { process.stderr.write(`${JSON.stringify(errorResult(error, argv))}\n`); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
