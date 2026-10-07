import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { getAddress, recoverMessageAddress } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import type { ClientEvmSigner } from '@x402/evm';
import type { BaseNetwork } from './spend.js';

const STATEMENT = 'Authorize one Voidly marketplace mutation. This does not transfer funds.';
const CHALLENGE_PATH = '/v1/providers/challenge';
const REGISTER_PATH = '/v1/providers/register';
const LISTING_CREATE_PATH = '/v1/listings';
const QUICKSTART_PATH = '/v1/sellers/quickstart';
const MAX_RESPONSE_BYTES = 4_096;
const MAX_LISTING_BYTES = 12_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const NONCE = /^[0-9a-f]{32}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const AGENT_DID = /^did:voidly:[1-9A-HJ-NP-Za-km-z]{1,32}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ORIGINS = {
  base: { origin: 'https://x402.voidly.ai', domain: 'x402.voidly.ai', chainId: 8453 },
  'base-sepolia': { origin: 'https://x402-staging.voidly.ai', domain: 'x402-staging.voidly.ai', chainId: 84532 },
} as const;

export interface PreparedVoidlySellerRegistration {
  submitUrl: string;
  body: { payload: Record<string, never>; message: string; signature: `0x${string}` };
}

/** The gateway's fixed listing-create payload. The gateway remains the admission authority. */
export interface VoidlySellerListingInput {
  name: string;
  description: string;
  category: string;
  upstreamUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  priceAtomic: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tags?: string[];
  outputPrivacy?: 'plain-json' | 'buyer-encrypted';
}

export interface PreparedVoidlySellerListingCreate {
  submitUrl: string;
  body: { payload: VoidlySellerListingInput; message: string; signature: `0x${string}` };
}

export interface VoidlySellerQuickstartInput {
  idempotencyKey: string;
  listing: VoidlySellerListingInput;
  did?: string;
}

export interface PreparedVoidlySellerQuickstart {
  submitUrl: string;
  body: { payload: VoidlySellerQuickstartInput; message: string; signature: `0x${string}` };
}

type SellerMutationAction = 'register' | 'listing_create' | 'seller_quickstart';

function digest(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function mutationResource(action: SellerMutationAction, path: string, canonicalPayload: string): string {
  const bodyDigest = digest(canonicalPayload);
  const mutationDigest = digest(JSON.stringify([
    'voidly-marketplace-mutation-v1', action, '', 'POST', path, bodyDigest,
  ]));
  return `urn:voidly:marketplace:mutation:v1:${action}:none:${mutationDigest.slice(2)}`;
}

function invalidChallenge(action: SellerMutationAction): never {
  throw new Error(`Voidly seller ${action === 'register' ? 'registration' : action === 'listing_create' ? 'listing' : 'quickstart'} challenge is invalid`);
}

function invalidListingInput(): never {
  throw new Error('Voidly seller listing payload is invalid');
}

/** Match the gateway's sorted-key JSON digest without accepting JS object hooks or unsafe values. */
function canonicalListingJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function validString(text: string, maxLength: number): boolean {
    if (text.length > maxLength || CONTROL.test(text)) return false;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }
  function encode(item: unknown, depth: number): string {
    if (++nodes > 2_048) invalidListingInput();
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)!;
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item)) invalidListingInput();
      return JSON.stringify(item)!;
    }
    if (typeof item === 'string') {
      if (!validString(item, 16_384)) invalidListingInput();
      return JSON.stringify(item)!;
    }
    if (!item || typeof item !== 'object' || depth >= 16 || ancestors.has(item)) invalidListingInput();
    ancestors.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      if (item.length > 2_048) invalidListingInput();
      for (let index = 0; index < item.length; index++) if (!(index in item)) invalidListingInput();
      encoded = `[${item.map(part => encode(part, depth + 1)).join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) invalidListingInput();
      const fields = Object.keys(item).sort().map(key => {
        if (!validString(key, 128) || UNSAFE_KEYS.has(key)) invalidListingInput();
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (!field || !Object.hasOwn(field, 'value')) invalidListingInput();
        return `${JSON.stringify(key)}:${encode(field.value, depth + 1)}`;
      });
      encoded = `{${fields.join(',')}}`;
    }
    ancestors.delete(item);
    return encoded;
  }
  const canonical = encode(value, 0);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_LISTING_BYTES) invalidListingInput();
  return canonical;
}

function checkedListingPayload(input: unknown): { payload: VoidlySellerListingInput; canonical: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidListingInput();
  const canonical = canonicalListingJson(input);
  const payload = JSON.parse(canonical) as VoidlySellerListingInput;
  const row = payload as unknown as Record<string, unknown>;
  const required = ['name', 'description', 'category', 'upstreamUrl', 'method', 'priceAtomic', 'inputSchema', 'outputSchema'];
  const optional = ['tags', 'outputPrivacy'];
  if (required.some(key => !Object.hasOwn(row, key)) ||
      Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalidListingInput();
  if (typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 100 || row.name !== row.name.trim() ||
      typeof row.description !== 'string' || row.description.length < 1 || row.description.length > 500 || row.description !== row.description.trim() ||
      typeof row.category !== 'string' || row.category.length < 1 || row.category.length > 64 || row.category !== row.category.trim() ||
      typeof row.upstreamUrl !== 'string' || typeof row.method !== 'string' ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(row.method) ||
      !Number.isSafeInteger(row.priceAtomic) || (row.priceAtomic as number) < 1 || (row.priceAtomic as number) > 10_000_000_000 ||
      !row.inputSchema || typeof row.inputSchema !== 'object' || Array.isArray(row.inputSchema) ||
      !row.outputSchema || typeof row.outputSchema !== 'object' || Array.isArray(row.outputSchema) ||
      row.outputPrivacy !== undefined && row.outputPrivacy !== 'plain-json' && row.outputPrivacy !== 'buyer-encrypted' ||
      row.outputPrivacy === 'buyer-encrypted' && row.method !== 'POST' ||
      row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.length > 10 ||
        row.tags.some(tag => typeof tag !== 'string' || !TAG.test(tag)) || new Set(row.tags).size !== row.tags.length)) {
    invalidListingInput();
  }
  let upstream: URL;
  try { upstream = new URL(row.upstreamUrl as string); } catch { invalidListingInput(); }
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.port ||
      upstream.search || upstream.hash || upstream.href !== row.upstreamUrl || isIP(hostname) !== 0 ||
      !hostname.includes('.') ||
      upstream.hostname === 'localhost' || upstream.hostname.endsWith('.localhost') ||
      upstream.hostname.endsWith('.local') || upstream.hostname.endsWith('.internal')) invalidListingInput();
  return { payload, canonical };
}

/** Local-only validation for CLI previews; it never accesses the wallet or network. */
export function validateVoidlySellerListingInput(input: unknown): VoidlySellerListingInput {
  return checkedListingPayload(input).payload;
}

function checkedQuickstartPayload(input: unknown): { payload: VoidlySellerQuickstartInput; canonical: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidListingInput();
  const row = input as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== (row.did === undefined ? 'idempotencyKey,listing' : 'did,idempotencyKey,listing') ||
      typeof row.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(row.idempotencyKey) ||
      row.did !== undefined && (typeof row.did !== 'string' || !AGENT_DID.test(row.did))) invalidListingInput();
  const listing = checkedListingPayload(row.listing).payload;
  const payload: VoidlySellerQuickstartInput = { idempotencyKey: row.idempotencyKey, listing,
    ...(row.did === undefined ? {} : { did: row.did as string }) };
  return { payload, canonical: canonicalListingJson(payload) };
}

async function boundedJson(response: Response, action: SellerMutationAction): Promise<unknown> {
  if (response.status !== 200 || response.redirected || response.type === 'opaqueredirect' ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalidChallenge(action);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)) invalidChallenge(action);
  if (!response.body) invalidChallenge(action);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 10_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) invalidChallenge(action);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('challenge_timeout')), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) invalidChallenge(action);
      chunks.push(next.value);
    }
  } catch { invalidChallenge(action); }
  finally { void reader.cancel().catch(() => undefined); }
  // Fetch may expose decoded bytes with the compressed wire Content-Length.
  if (size === 0) invalidChallenge(action);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { invalidChallenge(action); }
}

function checkedMessage(value: unknown, network: BaseNetwork, address: `0x${string}`,
  resource: string, action: SellerMutationAction, extraResources: string[] = []): {
  message: string; expiresAtMs: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).join(',') !== 'challenge') invalidChallenge(action);
  const challenge = (value as { challenge: unknown }).challenge;
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge) ||
      Object.keys(challenge).sort().join(',') !== 'expiresAt,message,nonce') invalidChallenge(action);
  const { message, nonce, expiresAt } = challenge as Record<string, unknown>;
  if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > 2_048 ||
      typeof nonce !== 'string' || typeof expiresAt !== 'string') invalidChallenge(action);
  const expected = ORIGINS[network];
  let parsed: ReturnType<typeof parseSiweMessage>;
  try { parsed = parseSiweMessage(message); } catch { invalidChallenge(action); }
  if (parsed.scheme !== 'https' || parsed.domain !== expected.domain ||
      parsed.uri !== `${expected.origin}${CHALLENGE_PATH}` ||
      parsed.chainId !== expected.chainId || parsed.version !== '1' ||
      parsed.statement !== STATEMENT || parsed.nonce !== nonce || !NONCE.test(nonce) ||
      !parsed.address || !parsed.issuedAt || !parsed.expirationTime ||
      parsed.notBefore !== undefined || parsed.requestId !== undefined ||
      !Array.isArray(parsed.resources) ||
      JSON.stringify(parsed.resources) !== JSON.stringify([resource, ...extraResources])) invalidChallenge(action);
  let messageAddress: string;
  try { messageAddress = getAddress(parsed.address).toLowerCase(); } catch { invalidChallenge(action); }
  if (messageAddress !== address.toLowerCase() ||
      !Number.isFinite(parsed.issuedAt.getTime()) ||
      !Number.isFinite(parsed.expirationTime.getTime()) ||
      parsed.expirationTime.getTime() - parsed.issuedAt.getTime() !== CHALLENGE_TTL_MS ||
      parsed.issuedAt.getTime() > Date.now() + 30_000 ||
      parsed.expirationTime.getTime() - Date.now() <= 5_000 ||
      expiresAt !== parsed.expirationTime.toISOString()) invalidChallenge(action);
  const canonical = createSiweMessage({
    scheme: 'https', domain: expected.domain, uri: `${expected.origin}${CHALLENGE_PATH}`,
    address: messageAddress as `0x${string}`, chainId: expected.chainId, version: '1',
    nonce, issuedAt: parsed.issuedAt, expirationTime: parsed.expirationTime,
    statement: STATEMENT, resources: [resource, ...extraResources],
  });
  if (canonical !== message) invalidChallenge(action);
  return { message, expiresAtMs: parsed.expirationTime.getTime() };
}

async function prepareMutation<T extends object>(input: {
  network: BaseNetwork;
  address: `0x${string}`;
  allowedOrigins: readonly string[];
  signer: ClientEvmSigner;
  fetcher: typeof fetch;
}, action: SellerMutationAction, path: string, payload: T, canonicalPayload: string,
  extraResources: string[] = []): Promise<{
  submitUrl: string;
  body: { payload: T; message: string; signature: `0x${string}` };
}> {
  const { origin } = ORIGINS[input.network];
  const label = action === 'register' ? 'registration' : action === 'listing_create' ? 'listing' : 'quickstart';
  if (!input.allowedOrigins.includes(origin)) throw new Error(`Voidly seller ${label} origin is not allowed`);
  const signer = input.signer as ClientEvmSigner & {
    signMessage?: (args: { message: string }) => Promise<`0x${string}`>;
  };
  if (typeof signer.signMessage !== 'function') throw new Error(`Voidly seller ${label} requires an EIP-191 signer`);
  const challengeUrl = `${origin}${CHALLENGE_PATH}`;
  let response: Response;
  try {
    response = await input.fetcher(challengeUrl, {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ wallet: input.address, action, payload }),
    });
  } catch { throw new Error(`Voidly seller ${label} challenge is unavailable`); }
  if (response.url && response.url !== challengeUrl) invalidChallenge(action);
  const resource = mutationResource(action, path, canonicalPayload);
  const { message, expiresAtMs } = checkedMessage(await boundedJson(response, action),
    input.network, input.address, resource, action, extraResources);
  let signature: `0x${string}`;
  try { signature = await signer.signMessage({ message }); }
  catch { throw new Error(`Voidly seller ${label} signing failed`); }
  if (Date.now() >= expiresAtMs) invalidChallenge(action);
  if (!SIGNATURE.test(signature)) throw new Error(`Voidly seller ${label} signature is invalid`);
  let recovered: `0x${string}`;
  try { recovered = await recoverMessageAddress({ message, signature }); }
  catch { throw new Error(`Voidly seller ${label} signature is invalid`); }
  if (recovered.toLowerCase() !== input.address.toLowerCase()) {
    throw new Error(`Voidly seller ${label} signature is invalid`);
  }
  return { submitUrl: `${origin}${path}`, body: { payload, message, signature } };
}

/** Prepare one fixed Voidly registration mutation; this never submits it. */
export async function prepareVoidlySellerRegistration(input: {
  network: BaseNetwork;
  address: `0x${string}`;
  allowedOrigins: readonly string[];
  signer: ClientEvmSigner;
  fetcher: typeof fetch;
}): Promise<PreparedVoidlySellerRegistration> {
  return prepareMutation(input, 'register', REGISTER_PATH, {}, '{}');
}

/** Sign only the fixed listing-create mutation; the caller must submit and retain the one-time secret. */
export async function prepareVoidlySellerListingCreate(input: {
  network: BaseNetwork;
  address: `0x${string}`;
  allowedOrigins: readonly string[];
  signer: ClientEvmSigner;
  fetcher: typeof fetch;
  payload: VoidlySellerListingInput;
}): Promise<PreparedVoidlySellerListingCreate> {
  const { payload, canonical } = checkedListingPayload(input.payload);
  return prepareMutation(input, 'listing_create', LISTING_CREATE_PATH, payload, canonical);
}

/** Prepare one fixed, one-use quickstart mutation; a fresh challenge is required for a signed retry. */
export async function prepareVoidlySellerQuickstart(input: {
  network: BaseNetwork;
  address: `0x${string}`;
  allowedOrigins: readonly string[];
  signer: ClientEvmSigner;
  fetcher: typeof fetch;
  payload: VoidlySellerQuickstartInput;
}): Promise<PreparedVoidlySellerQuickstart> {
  const { payload, canonical } = checkedQuickstartPayload(input.payload);
  return prepareMutation(input, 'seller_quickstart', QUICKSTART_PATH, payload, canonical,
    payload.did ? [payload.did] : []);
}
