/** Pure allowance contract. Validation does not verify a signature or prove human approval. */
export const SPEND_ALLOWANCE_VERSION = 'voidpay-spend-allowance/v1' as const;
export const SPEND_ALLOWANCE_PROOF_VERSION = 'voidpay-spend-allowance-proof/v1' as const;
export const SPEND_ALLOWANCE_MAX_DAILY_ATOMIC = 100_000_000n;
export const SPEND_ALLOWANCE_MAX_PER_CALL_ATOMIC = 10_000_000n;
export const SPEND_ALLOWANCE_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const SPEND_ALLOWANCE_MAX_PROOF_SECONDS = 300;

export type SpendAllowanceNetwork = 'eip155:8453' | 'eip155:84532';
export type SpendAllowanceOrigin = 'https://x402.voidly.ai' | 'https://x402-staging.voidly.ai';
export type SpendAllowanceAction = 'grant' | 'status' | 'revoke' | 'reserve';
export type SpendAllowanceHex = `0x${string}`;

const ROUTES = {
  'eip155:8453': { origin: 'https://x402.voidly.ai', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  'eip155:84532': { origin: 'https://x402-staging.voidly.ai', asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' },
} as const;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DIGEST = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;
const GRANT_FIELDS = ['version', 'grantId', 'origin', 'network', 'asset', 'owner', 'payer',
  'dailyLimitAtomic', 'perCallLimitAtomic', 'validAfter', 'expiresAt', 'listings'] as const;
const QUOTE_FIELDS = ['quoteId', 'resourceUrl', 'listingId', 'listingVersion', 'payTo', 'payer',
  'network', 'asset', 'amountAtomic', 'inputSha256', 'quoteExpiresAt'] as const;

export interface SpendAllowanceListing { listingId: string; version: number; payTo: SpendAllowanceHex }
export interface SpendAllowanceGrant {
  version: typeof SPEND_ALLOWANCE_VERSION;
  grantId: string;
  origin: SpendAllowanceOrigin;
  network: SpendAllowanceNetwork;
  asset: SpendAllowanceHex;
  /** MVP: the approving wallet and spending wallet must be identical. */
  owner: SpendAllowanceHex;
  payer: SpendAllowanceHex;
  /** Positive canonical decimal strings in USDC atomic units. */
  dailyLimitAtomic: string;
  perCallLimitAtomic: string;
  /** Unix seconds; expiry is exclusive. */
  validAfter: number;
  expiresAt: number;
  listings: SpendAllowanceListing[];
}

export interface SpendAllowanceSigningInput {
  action: SpendAllowanceAction;
  network: SpendAllowanceNetwork;
  origin: SpendAllowanceOrigin;
  grantId: string;
  bodyHash: SpendAllowanceHex;
  nonce: SpendAllowanceHex;
  /** Unix seconds; no more than 300 seconds after the verifier's clock. */
  expiresAt: number;
}

export interface SpendAllowanceProof {
  nonce: SpendAllowanceHex;
  expiresAt: number;
  /** A 65-byte EIP-191 signature. This type alone does not verify it. */
  signature: SpendAllowanceHex;
}

export interface SpendAllowanceQuote {
  quoteId: SpendAllowanceHex;
  resourceUrl: string;
  listingId: string;
  listingVersion: number;
  payTo: SpendAllowanceHex;
  payer: SpendAllowanceHex;
  network: SpendAllowanceNetwork;
  asset: SpendAllowanceHex;
  amountAtomic: string;
  inputSha256: SpendAllowanceHex;
  /** Unix milliseconds, as in the existing Marketplace quote. */
  quoteExpiresAt: number;
}

export interface SpendAllowanceReservation extends SpendAllowanceQuote {
  grantId: string;
  /** UTC calendar day whose budget was debited. No automatic refund is implied. */
  day: string;
  /** Unix milliseconds, bounded by quote expiry, grant expiry and UTC day end. */
  reservedUntil: number;
  /** The gateway binds the original payment key during verified payment admission. */
  paymentKey: null;
}

function fail(reason: string): never { throw new Error(`Invalid spend allowance: ${reason}`); }

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

function positiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function seconds(value: unknown): value is number {
  return positiveSafe(value) && value <= MAX_TIMESTAMP_SECONDS;
}

function milliseconds(value: unknown): value is number {
  return positiveSafe(value) && value <= MAX_TIMESTAMP_SECONDS * 1_000;
}

function address(value: unknown): value is SpendAllowanceHex {
  return typeof value === 'string' && ADDRESS.test(value) && value !== ZERO_ADDRESS;
}

function digest(value: unknown): value is SpendAllowanceHex {
  return typeof value === 'string' && DIGEST.test(value);
}

function amount(value: unknown, maximum: bigint): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value) && BigInt(value) <= maximum;
}

function route(network: unknown, origin: unknown, asset?: unknown): boolean {
  if (network !== 'eip155:8453' && network !== 'eip155:84532') return false;
  return origin === ROUTES[network].origin && (asset === undefined || asset === ROUTES[network].asset);
}

/** Strict canonical JSON subset used by both wallet and gateway, with bounded work. */
export function canonicalSpendAllowanceJson(value: unknown): string {
  let nodes = 0;
  const walk = (item: unknown, depth: number): string => {
    if (++nodes > 4_096 || depth > 16) fail('JSON exceeds limits');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (new TextEncoder().encode(item).length > 8_192) fail('JSON string exceeds limits');
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail('JSON number must be a safe integer');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (item.length > 1_024 || Object.keys(item).length !== item.length ||
          Reflect.ownKeys(item).length !== item.length + 1) fail('invalid JSON array');
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('invalid JSON array');
        values.push(walk(descriptor.value, depth + 1));
      }
      return `[${values.join(',')}]`;
    }
    if (!plainRecord(item)) fail('body must be plain JSON');
    return `{${Object.keys(item).sort().map(key =>
      `${JSON.stringify(key)}:${walk(item[key], depth + 1)}`).join(',')}}`;
  };
  const result = walk(value, 0);
  if (new TextEncoder().encode(result).length > 32_768) fail('JSON exceeds limits');
  return result;
}

/** Canonical SHA-256 body digest; no signing or network operation occurs here. */
export async function spendAllowanceBodyHash(value: unknown): Promise<SpendAllowanceHex> {
  const bytes = new TextEncoder().encode(canonicalSpendAllowanceJson(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `0x${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Validate stored shape even when expired. Caller must separately verify signature and active status. */
export function checkedSpendAllowanceGrant(value: unknown): SpendAllowanceGrant {
  if (!exactObject(value, GRANT_FIELDS) || value.version !== SPEND_ALLOWANCE_VERSION ||
      typeof value.grantId !== 'string' || !UUID.test(value.grantId) ||
      !route(value.network, value.origin, value.asset) || !address(value.owner) ||
      !address(value.payer) || value.owner !== value.payer ||
      !amount(value.dailyLimitAtomic, SPEND_ALLOWANCE_MAX_DAILY_ATOMIC) ||
      !amount(value.perCallLimitAtomic, SPEND_ALLOWANCE_MAX_PER_CALL_ATOMIC) ||
      BigInt(value.perCallLimitAtomic) > BigInt(value.dailyLimitAtomic) ||
      !seconds(value.validAfter) || !seconds(value.expiresAt) || value.expiresAt <= value.validAfter ||
      value.expiresAt - value.validAfter > SPEND_ALLOWANCE_MAX_LIFETIME_SECONDS ||
      !Array.isArray(value.listings) || value.listings.length < 1 || value.listings.length > 32) fail('invalid grant');
  // Also rejects accessors, sparse arrays, symbols and fields JSON would silently omit.
  canonicalSpendAllowanceJson(value);
  const listings: SpendAllowanceListing[] = [];
  const seen = new Set<string>();
  for (const item of value.listings) {
    if (!exactObject(item, ['listingId', 'version', 'payTo']) ||
        typeof item.listingId !== 'string' || !LISTING_ID.test(item.listingId) ||
        !positiveSafe(item.version) || !address(item.payTo)) fail('invalid listing');
    const key = `${item.listingId}|${item.version}|${item.payTo}`;
    if (seen.has(key)) fail('duplicate listing');
    seen.add(key);
    listings.push({ listingId: item.listingId, version: item.version, payTo: item.payTo });
  }
  return { version: SPEND_ALLOWANCE_VERSION, grantId: value.grantId,
    origin: value.origin as SpendAllowanceOrigin, network: value.network as SpendAllowanceNetwork,
    asset: value.asset as SpendAllowanceHex, owner: value.owner, payer: value.payer,
    dailyLimitAtomic: value.dailyLimitAtomic, perCallLimitAtomic: value.perCallLimitAtomic,
    validAfter: value.validAfter, expiresAt: value.expiresAt, listings };
}

export function canonicalSpendAllowanceGrant(value: unknown): string {
  return canonicalSpendAllowanceJson(checkedSpendAllowanceGrant(value));
}

/** Time check only; revocation and remaining budget are authoritative on the server. */
export function assertSpendAllowanceActive(value: unknown, nowSeconds: number): SpendAllowanceGrant {
  const grant = checkedSpendAllowanceGrant(value);
  if (!seconds(nowSeconds) || nowSeconds < grant.validAfter || nowSeconds >= grant.expiresAt) fail('grant is not active');
  return grant;
}

/** Pass the returned UTF-8 text to EIP-191 signMessage, never sign its text as a hex payload. */
export function spendAllowanceSigningMessage(value: SpendAllowanceSigningInput, nowSeconds: number): string {
  if (!exactObject(value, ['action', 'network', 'origin', 'grantId', 'bodyHash', 'nonce', 'expiresAt']) ||
      !['grant', 'status', 'revoke', 'reserve'].includes(value.action) || !route(value.network, value.origin) ||
      typeof value.grantId !== 'string' || !UUID.test(value.grantId) || !digest(value.bodyHash) ||
      !digest(value.nonce) || !seconds(nowSeconds) || !seconds(value.expiresAt) ||
      value.expiresAt <= nowSeconds || value.expiresAt - nowSeconds > SPEND_ALLOWANCE_MAX_PROOF_SECONDS) fail('invalid proof input');
  return [SPEND_ALLOWANCE_PROOF_VERSION, value.action, value.network, value.origin, value.grantId,
    value.bodyHash, value.nonce, value.expiresAt].join('\n');
}

export function checkedSpendAllowanceProof(value: unknown, nowSeconds: number): SpendAllowanceProof {
  if (!exactObject(value, ['nonce', 'expiresAt', 'signature']) || !digest(value.nonce) ||
      !seconds(nowSeconds) || !seconds(value.expiresAt) || value.expiresAt <= nowSeconds ||
      value.expiresAt - nowSeconds > SPEND_ALLOWANCE_MAX_PROOF_SECONDS ||
      typeof value.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(value.signature)) fail('invalid proof');
  return { nonce: value.nonce, expiresAt: value.expiresAt, signature: value.signature as SpendAllowanceHex };
}

/** Check one original, trusted quote against the owner's exact listing and cap selection. */
export function assertSpendAllowanceQuote(value: unknown, rawQuote: unknown, nowMilliseconds: number): SpendAllowanceQuote {
  if (!milliseconds(nowMilliseconds)) fail('invalid clock');
  const grant = assertSpendAllowanceActive(value, Math.floor(nowMilliseconds / 1_000));
  if (!exactObject(rawQuote, QUOTE_FIELDS) || !digest(rawQuote.quoteId) || !digest(rawQuote.inputSha256) ||
      typeof rawQuote.listingId !== 'string' || !LISTING_ID.test(rawQuote.listingId) ||
      !positiveSafe(rawQuote.listingVersion) || !address(rawQuote.payTo) || rawQuote.payer !== grant.payer ||
      rawQuote.network !== grant.network || rawQuote.asset !== grant.asset ||
      !amount(rawQuote.amountAtomic, BigInt(grant.perCallLimitAtomic)) ||
      !milliseconds(rawQuote.quoteExpiresAt) || rawQuote.quoteExpiresAt <= nowMilliseconds ||
      rawQuote.resourceUrl !== `${grant.origin}/v1/services/${rawQuote.listingId}/call?quote=${rawQuote.quoteId}` ||
      !grant.listings.some(item => item.listingId === rawQuote.listingId &&
        item.version === rawQuote.listingVersion && item.payTo === rawQuote.payTo)) fail('quote does not match grant');
  return { quoteId: rawQuote.quoteId, inputSha256: rawQuote.inputSha256, resourceUrl: rawQuote.resourceUrl as string,
    listingId: rawQuote.listingId, listingVersion: rawQuote.listingVersion, payTo: rawQuote.payTo,
    payer: grant.payer, network: grant.network, asset: grant.asset,
    amountAtomic: rawQuote.amountAtomic, quoteExpiresAt: rawQuote.quoteExpiresAt };
}

/** Validate the pre-signature reservation response and its full original quote identity. */
export function checkedSpendAllowanceReservation(value: unknown, rawQuote: unknown, rawReservation: unknown,
  nowMilliseconds: number): SpendAllowanceReservation {
  const grant = checkedSpendAllowanceGrant(value);
  const quote = assertSpendAllowanceQuote(grant, rawQuote, nowMilliseconds);
  const day = new Date(nowMilliseconds).toISOString().slice(0, 10);
  const dayEnd = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
  const reservedUntil = Math.min(quote.quoteExpiresAt, grant.expiresAt * 1_000, dayEnd);
  if (!exactObject(rawReservation, [...QUOTE_FIELDS, 'grantId', 'day', 'reservedUntil', 'paymentKey']) ||
      rawReservation.grantId !== grant.grantId || rawReservation.day !== day ||
      rawReservation.reservedUntil !== reservedUntil || rawReservation.paymentKey !== null ||
      !QUOTE_FIELDS.every(key => rawReservation[key] === quote[key])) fail('reservation does not match original quote');
  return { ...quote, grantId: grant.grantId, day, reservedUntil, paymentKey: null };
}

/** Check before payment signing and again against the actual EIP-3009 validBefore. */
export function assertSpendAllowanceAuthorizationWindow(reservation: SpendAllowanceReservation,
  validBeforeSeconds: number, nowMilliseconds: number): void {
  if (!milliseconds(nowMilliseconds) || !milliseconds(reservation.reservedUntil) ||
      !seconds(validBeforeSeconds) || validBeforeSeconds * 1_000 <= nowMilliseconds ||
      validBeforeSeconds * 1_000 > reservation.reservedUntil) fail('authorization exceeds reservation window');
}
