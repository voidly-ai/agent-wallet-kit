import { performance } from 'node:perf_hooks';
import { getAddress, zeroAddress } from 'viem';
import type { BaseNetwork } from './spend.js';

const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const MAX_DETAIL_BYTES = 256 * 1024;
const DETAIL_TIMEOUT_MS = 10_000;

const GATEWAYS = {
  base: {
    origin: 'https://x402.voidly.ai',
    network: 'eip155:8453',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  'base-sepolia': {
    origin: 'https://x402-staging.voidly.ai',
    network: 'eip155:84532',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
} as const;

export interface BuyListingItem {
  kind: 'seller';
  id: string;
  version: number;
  status: 'live';
  method: 'POST';
  detailUrl: string;
  callUrl: string;
  network: 'eip155:8453' | 'eip155:84532';
  asset: `0x${string}`;
  priceUsdcAtomic: string;
  payTo: `0x${string}`;
  inputSchema: Record<string, unknown>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readBoundedDetail(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Listing detail response has no body');
  const deadline = performance.now() + DETAIL_TIMEOUT_MS;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error('Listing detail response timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Listing detail response timed out')), remainingMs);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) {
        complete = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > MAX_DETAIL_BYTES) throw new Error('Listing detail response is too large');
      chunks.push(next.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    throw new Error('Listing detail response is not valid UTF-8 JSON');
  }
}

/** Read one exact seller version from the trusted Base gateway; this never pays or signs. */
export async function fetchMarketplaceListing(
  listingId: string,
  version: number,
  network: BaseNetwork,
  /** Offline test seam. Runtime uses the platform fetch. */
  fetcher: typeof fetch = fetch,
): Promise<BuyListingItem> {
  if (!LISTING_ID.test(listingId)) throw new Error('Invalid listing ID');
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Expected listing version must be a positive safe integer');
  }
  if (!Object.hasOwn(GATEWAYS, network)) throw new Error('Unsupported Base network');
  const gateway = GATEWAYS[network];
  const detailUrl = `${gateway.origin}/v1/services/${listingId}?network=${gateway.network}&version=${version}`;
  const callUrl = `${gateway.origin}/v1/services/${listingId}/call`;
  const response = await fetcher(detailUrl, {
    method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
    signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
  });
  if (response.redirected || response.url && response.url !== detailUrl) {
    throw new Error('Listing detail response changed resource');
  }
  if (response.status !== 200) throw new Error(`Listing detail unavailable (HTTP ${response.status})`);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Listing detail response must be JSON');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (/^(?:0|[1-9][0-9]*)$/.test(contentLength) === false ||
      BigInt(contentLength) > BigInt(MAX_DETAIL_BYTES))) {
    throw new Error('Listing detail response has an invalid length');
  }

  const payload = await readBoundedDetail(response);
  if (!plainRecord(payload) || payload.version !== '1' || !plainRecord(payload.item)) {
    throw new Error('Listing detail response has an invalid shape');
  }
  const item = payload.item;
  if (item.kind !== 'seller' || item.id !== listingId || item.version !== version ||
      item.status !== 'live' || item.method !== 'POST' || item.detailUrl !== detailUrl ||
      item.callUrl !== callUrl || item.network !== gateway.network ||
      typeof item.asset !== 'string' || item.asset.toLowerCase() !== gateway.usdc.toLowerCase() ||
      typeof item.priceUsdcAtomic !== 'string' || !/^[1-9][0-9]{0,14}$/.test(item.priceUsdcAtomic) ||
      typeof item.payTo !== 'string' || !plainRecord(item.inputSchema)) {
    throw new Error('Listing detail does not match the selected seller, network, or payment route');
  }
  let payTo: `0x${string}`;
  try { payTo = getAddress(item.payTo); }
  catch { throw new Error('Listing detail has an invalid seller wallet'); }
  if (payTo.toLowerCase() === zeroAddress) throw new Error('Listing detail has an invalid seller wallet');

  const selected: BuyListingItem = {
    kind: 'seller', id: listingId, version, status: 'live', method: 'POST',
    detailUrl, callUrl, network: gateway.network, asset: gateway.usdc,
    priceUsdcAtomic: item.priceUsdcAtomic, payTo, inputSchema: item.inputSchema,
  };
  return selected;
}
