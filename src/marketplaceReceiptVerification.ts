/** Independent verification of gateway-signed Marketplace outcomes. */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { checkedMarketplaceOrigin, type MarketplaceAttempt, type MarketplaceOrigin } from './marketplaceRecovery.js';

export const MARKETPLACE_RECEIPT_KEYS_URL =
  'https://x402.voidly.ai/.well-known/voidpay-receipt-keys.json' as const;

const RECEIPT_VERSION = 'voidpay-x402-delivery-v1';
const KEYS_VERSION = 'voidpay-receipt-keys-v1';
const RECEIPT_KEYS_PATH = '/.well-known/voidpay-receipt-keys.json';
const MAX_RECEIPT_HEADER_BYTES = 4_096;
const MAX_REGISTRY_BYTES = 8_192;
const MAX_BODY_BYTES = 1_048_576;
const HEX_32 = /^0x[0-9a-f]{64}$/;
const HEX_20 = /^0x[0-9a-f]{40}$/;
const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const FAILURE_CODE = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const ASSET: Record<MarketplaceAttempt['network'], string> = {
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const PAYLOAD_KEYS = [
  'version', 'keyVersion', 'network', 'asset', 'transactionHash', 'payerWallet',
  'payTo', 'amountAtomic', 'resourceUrl', 'context', 'blockNumber',
  'confirmationsAtDelivery', 'listingId', 'listingVersion',
  'inputSha256', 'outputSha256', 'deliveredAt', 'status', 'quoteId',
  'quoteExpiresAt', 'paymentKey', 'outputSchemaMatched', 'failureCode', 'outcomeAt',
] as const;
const SIGNED_KEYS = [...PAYLOAD_KEYS, 'signature'] as const;

export interface VerifiedMarketplaceReceipt {
  version: typeof RECEIPT_VERSION;
  keyVersion: number;
  network: MarketplaceAttempt['network'];
  asset: string;
  transactionHash: string;
  payerWallet: string;
  payTo: string;
  amountAtomic: string;
  resourceUrl: string;
  context: { jobId: string; awardId: string; legId: string } | null;
  blockNumber: string;
  confirmationsAtDelivery: number;
  listingId: string;
  listingVersion: number;
  inputSha256: string;
  outputSha256: string | null;
  deliveredAt: number | null;
  status: 'delivered' | 'refund_owed';
  quoteId: string;
  quoteExpiresAt: number;
  paymentKey: string;
  outputSchemaMatched: true | null;
  failureCode: string | null;
  outcomeAt: number;
  signature: string;
}

export interface VerifiedMarketplaceOutcome {
  status: 'delivered' | 'refund_owed';
  receipt: VerifiedMarketplaceReceipt;
}

function fail(reason: string): never {
  throw new Error(`Marketplace receipt verification failed: ${reason}`);
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}

function positiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validJobContext(value: unknown): value is VerifiedMarketplaceReceipt['context'] {
  return value === null || exactObject(value, ['jobId', 'awardId', 'legId']) &&
    typeof value.jobId === 'string' && UUID.test(value.jobId) &&
    typeof value.awardId === 'string' && UUID.test(value.awardId) &&
    typeof value.legId === 'string' && UUID.test(value.legId);
}

function canonicalJobContext(value: NonNullable<VerifiedMarketplaceReceipt['context']>): string {
  return JSON.stringify({ jobId: value.jobId, awardId: value.awardId, legId: value.legId });
}

function fromBase64url(value: unknown, maximumBytes: number, exactBytes?: number): Buffer {
  if (typeof value !== 'string' || !B64URL.test(value) || value.length % 4 === 1 ||
      value.length > Math.ceil(maximumBytes * 4 / 3) + 3) fail('invalid base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > maximumBytes || exactBytes !== undefined && bytes.length !== exactBytes ||
      bytes.toString('base64url') !== value) fail('invalid base64url');
  return bytes;
}

async function boundedBytes(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('response body timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            'Marketplace receipt verification failed: response body timed out')), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) fail('response body exceeds limit');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    // A cloned stream is teed with the still-readable original. Awaiting
    // cancellation here can hang until the original branch is consumed.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* Pending read is being cancelled. */ }
  }
}

function strictJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('invalid JSON'); }
}

function checkedReceipt(raw: unknown, origin: MarketplaceOrigin): VerifiedMarketplaceReceipt {
  if (!exactObject(raw, SIGNED_KEYS)) fail('invalid receipt fields');
  const r = raw;
  if (r.version !== RECEIPT_VERSION || !positiveSafe(r.keyVersion) || r.keyVersion > 65_535 ||
      (r.network !== 'eip155:84532' && r.network !== 'eip155:8453') ||
      r.asset !== ASSET[r.network] || typeof r.transactionHash !== 'string' ||
      !HEX_32.test(r.transactionHash) || typeof r.payerWallet !== 'string' ||
      !HEX_20.test(r.payerWallet) || typeof r.payTo !== 'string' || !HEX_20.test(r.payTo) ||
      typeof r.amountAtomic !== 'string' || !/^[1-9][0-9]*$/.test(r.amountAtomic) ||
      BigInt(r.amountAtomic) > 10_000_000_000n ||
      typeof r.listingId !== 'string' || !LISTING_ID.test(r.listingId) ||
      !positiveSafe(r.listingVersion) || typeof r.inputSha256 !== 'string' ||
      !HEX_32.test(r.inputSha256) || typeof r.quoteId !== 'string' || !HEX_32.test(r.quoteId) ||
      typeof r.paymentKey !== 'string' || !HEX_32.test(r.paymentKey) ||
      !validJobContext(r.context) || typeof r.blockNumber !== 'string' ||
      !/^[1-9][0-9]*$/.test(r.blockNumber) ||
      BigInt(r.blockNumber) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !positiveSafe(r.confirmationsAtDelivery) ||
      !positiveSafe(r.quoteExpiresAt) || !positiveSafe(r.outcomeAt) ||
      r.resourceUrl !== `${origin}/v1/services/${r.listingId}/call?quote=${r.quoteId}`) {
    fail('invalid receipt payload');
  }
  if (r.status === 'delivered') {
    if (typeof r.outputSha256 !== 'string' || !HEX_32.test(r.outputSha256) ||
        r.outputSchemaMatched !== true || !positiveSafe(r.deliveredAt) ||
        r.deliveredAt !== r.outcomeAt || r.failureCode !== null) {
      fail('invalid delivered receipt');
    }
  } else if (r.status === 'refund_owed') {
    if (r.outputSha256 !== null || r.outputSchemaMatched !== null ||
        r.deliveredAt !== null || typeof r.failureCode !== 'string' ||
        !FAILURE_CODE.test(r.failureCode)) fail('invalid refund receipt');
  } else {
    fail('invalid receipt status');
  }
  fromBase64url(r.signature, 64, 64);
  return r as unknown as VerifiedMarketplaceReceipt;
}

function canonicalPayload(receipt: VerifiedMarketplaceReceipt): Buffer {
  return Buffer.from(`{${[...PAYLOAD_KEYS].sort().map(key =>
    `${JSON.stringify(key)}:${key === 'context' && receipt.context !== null
      ? canonicalJobContext(receipt.context) : JSON.stringify(receipt[key])}`).join(',')}}`, 'utf8');
}

function encodedReceipt(receipt: VerifiedMarketplaceReceipt): string {
  const json = `{${[...SIGNED_KEYS].sort().map(key =>
    `${JSON.stringify(key)}:${JSON.stringify(receipt[key])}`).join(',')}}`;
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeReceipt(header: string | null, origin: MarketplaceOrigin): VerifiedMarketplaceReceipt {
  if (!header) fail('missing signed receipt');
  const bytes = fromBase64url(header, MAX_RECEIPT_HEADER_BYTES);
  const receipt = checkedReceipt(strictJson(bytes), origin);
  if (encodedReceipt(receipt) !== header) fail('noncanonical signed receipt');
  return receipt;
}

interface RegistryKey { keyVersion: number; publicKeySpki: string; status: 'active' | 'verify_only' }

function checkedRegistry(raw: unknown): RegistryKey[] {
  if (!exactObject(raw, ['version', 'activeKeyVersion', 'keys']) ||
      raw.version !== KEYS_VERSION || !positiveSafe(raw.activeKeyVersion) ||
      raw.activeKeyVersion > 65_535 || !Array.isArray(raw.keys) ||
      raw.keys.length < 1 || raw.keys.length > 16) fail('invalid key registry');
  const keys: RegistryKey[] = [];
  const seen = new Set<number>();
  for (const item of raw.keys) {
    if (!exactObject(item, ['keyVersion', 'algorithm', 'publicKeySpki', 'status']) ||
        !positiveSafe(item.keyVersion) || item.keyVersion > 65_535 ||
        seen.has(item.keyVersion) || item.algorithm !== 'Ed25519' ||
        (item.status !== 'active' && item.status !== 'verify_only') ||
        typeof item.publicKeySpki !== 'string' || item.publicKeySpki.length > 256) {
      fail('invalid key registry');
    }
    // DER SPKI for Ed25519: algorithm identifier and one 32-byte public key.
    const spki = fromBase64url(item.publicKeySpki, 100);
    if (spki.length !== 44 ||
        !spki.subarray(0, 12).equals(Buffer.from('302a300506032b6570032100', 'hex'))) {
      fail('invalid Ed25519 public key');
    }
    seen.add(item.keyVersion);
    keys.push({ keyVersion: item.keyVersion, publicKeySpki: item.publicKeySpki,
      status: item.status });
  }
  if (keys.filter(key => key.status === 'active').length !== 1 ||
      !keys.some(key => key.keyVersion === raw.activeKeyVersion && key.status === 'active')) {
    fail('invalid active key');
  }
  return keys;
}

async function registryKeys(fetcher: typeof fetch, origin: MarketplaceOrigin): Promise<RegistryKey[]> {
  const registryUrl = `${origin}${RECEIPT_KEYS_PATH}`;
  const response = await fetcher(registryUrl, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  if (response.status !== 200 || response.redirected ||
      response.url && response.url !== registryUrl ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    fail('public key registry unavailable');
  }
  return checkedRegistry(strictJson(await boundedBytes(response, MAX_REGISTRY_BYTES)));
}

function bindAttempt(receipt: VerifiedMarketplaceReceipt, attempt: MarketplaceAttempt): void {
  if (receipt.quoteId !== attempt.quoteId.toLowerCase() ||
      receipt.paymentKey !== attempt.paymentKey.toLowerCase() ||
      receipt.payerWallet !== attempt.wallet.toLowerCase() ||
      receipt.payTo !== attempt.payTo.toLowerCase() ||
      receipt.asset !== attempt.asset.toLowerCase() ||
      receipt.network !== attempt.network || receipt.amountAtomic !== attempt.amountAtomic ||
      receipt.resourceUrl !== attempt.quoteUrl || receipt.listingId !== attempt.listingId ||
      receipt.listingVersion !== attempt.listingVersion ||
      receipt.inputSha256 !== attempt.quotedInputSha256.toLowerCase()) {
    fail('signed receipt does not match the durable payment attempt');
  }
}

function sameJobContext(raw: unknown, expected: VerifiedMarketplaceReceipt['context']): boolean {
  if (expected === null) return raw === null;
  return validJobContext(raw) && raw !== null &&
    raw.jobId === expected.jobId && raw.awardId === expected.awardId &&
    raw.legId === expected.legId;
}

function sameReceiptObject(raw: unknown, receipt: VerifiedMarketplaceReceipt): boolean {
  if (!exactObject(raw, SIGNED_KEYS)) return false;
  return SIGNED_KEYS.every(key => key === 'context'
    ? sameJobContext(raw.context, receipt.context)
    : raw[key] === receipt[key]);
}

/** A receipt is trusted only after fixed-origin key lookup, signature, attempt and body checks. */
export async function verifyMarketplaceOutcome(
  response: Response,
  attempt: MarketplaceAttempt,
  route: 'paid' | 'recovery',
  fetcher: typeof fetch = fetch,
): Promise<VerifiedMarketplaceOutcome> {
  if (route !== 'paid' && route !== 'recovery') fail('invalid route');
  const origin = checkedMarketplaceOrigin(attempt.targetUrl);
  if (origin === 'https://x402-staging.voidly.ai' && attempt.network !== 'eip155:84532') {
    fail('Marketplace staging requires Base Sepolia');
  }
  const expectedUrl = route === 'paid' ? attempt.targetUrl :
    `${origin}/v1/services/${attempt.listingId}/quotes/${attempt.quoteId}/result`;
  if (response.redirected || response.url && response.url !== expectedUrl) {
    fail('outcome response origin or path mismatch');
  }
  const receipt = decodeReceipt(response.headers.get('x-voidpay-delivery-receipt'), origin);
  bindAttempt(receipt, attempt);
  const key = (await registryKeys(fetcher, origin)).find(item => item.keyVersion === receipt.keyVersion);
  if (!key) fail('receipt key version is not published');
  const valid = verifySignature(null, canonicalPayload(receipt),
    createPublicKey({ key: fromBase64url(key.publicKeySpki, 100), format: 'der', type: 'spki' }),
    fromBase64url(receipt.signature, 64, 64));
  if (!valid) fail('invalid Ed25519 signature');
  if (receipt.status === 'delivered') {
    if (response.status < 200 || response.status > 299 ||
        route === 'recovery' && response.status !== 200 ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      fail('delivered response status or content type mismatch');
    }
    const bytes = await boundedBytes(response.clone(), MAX_BODY_BYTES);
    if (`0x${createHash('sha256').update(bytes).digest('hex')}` !== receipt.outputSha256) {
      fail('delivered body hash mismatch');
    }
  } else {
    if (response.status !== (route === 'paid' ? 502 : 200) ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      fail('refund response status or content type mismatch');
    }
    const body = strictJson(await boundedBytes(response.clone(), MAX_BODY_BYTES));
    const expectedFields = route === 'paid' ?
      ['error', 'refund_owed', 'refund_reference'] :
      ['status', 'refund_owed', 'refund_reference', 'receipt'];
    if (!exactObject(body, expectedFields)) fail('invalid refund body');
    const b = body;
    if (b.refund_owed !== true || b.refund_reference !== receipt.transactionHash ||
        (route === 'paid' ? !['delivery_unavailable', 'seller_delivery_failed'].includes(String(b.error)) :
          b.status !== 'refund_owed' || !sameReceiptObject(b.receipt, receipt))) {
      fail('refund body does not match signed receipt');
    }
  }
  return { status: receipt.status, receipt };
}
