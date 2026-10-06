import { createHash } from 'node:crypto';
import { getAddress, recoverMessageAddress } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import type { ClientEvmSigner } from '@x402/evm';
import type { BaseNetwork } from './spend.js';

const STATEMENT = 'Authorize one Voidly marketplace mutation. This does not transfer funds.';
const CHALLENGE_PATH = '/v1/providers/challenge';
const REGISTER_PATH = '/v1/providers/register';
const MAX_RESPONSE_BYTES = 4_096;
const CHALLENGE_TTL_MS = 5 * 60_000;
const NONCE = /^[0-9a-f]{32}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ORIGINS = {
  base: { origin: 'https://x402.voidly.ai', domain: 'x402.voidly.ai', chainId: 8453 },
  'base-sepolia': { origin: 'https://x402-staging.voidly.ai', domain: 'x402-staging.voidly.ai', chainId: 84532 },
} as const;

export interface PreparedVoidlySellerRegistration {
  submitUrl: string;
  body: { payload: Record<string, never>; message: string; signature: `0x${string}` };
}

function digest(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function registrationResource(): string {
  const bodyDigest = digest('{}');
  const mutationDigest = digest(JSON.stringify([
    'voidly-marketplace-mutation-v1', 'register', '', 'POST', REGISTER_PATH, bodyDigest,
  ]));
  return `urn:voidly:marketplace:mutation:v1:register:none:${mutationDigest.slice(2)}`;
}

function invalidChallenge(): never {
  throw new Error('Voidly seller registration challenge is invalid');
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 200 || response.redirected || response.type === 'opaqueredirect' ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalidChallenge();
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)) invalidChallenge();
  if (!response.body) invalidChallenge();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 10_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) invalidChallenge();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('challenge_timeout')), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) invalidChallenge();
      chunks.push(next.value);
    }
  } catch { invalidChallenge(); }
  finally { void reader.cancel().catch(() => undefined); }
  // Fetch may expose decoded bytes with the compressed wire Content-Length.
  if (size === 0) invalidChallenge();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { invalidChallenge(); }
}

function checkedMessage(value: unknown, network: BaseNetwork, address: `0x${string}`): {
  message: string; expiresAtMs: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).join(',') !== 'challenge') invalidChallenge();
  const challenge = (value as { challenge: unknown }).challenge;
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge) ||
      Object.keys(challenge).sort().join(',') !== 'expiresAt,message,nonce') invalidChallenge();
  const { message, nonce, expiresAt } = challenge as Record<string, unknown>;
  if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > 2_048 ||
      typeof nonce !== 'string' || typeof expiresAt !== 'string') invalidChallenge();
  const expected = ORIGINS[network];
  let parsed: ReturnType<typeof parseSiweMessage>;
  try { parsed = parseSiweMessage(message); } catch { invalidChallenge(); }
  if (parsed.scheme !== 'https' || parsed.domain !== expected.domain ||
      parsed.uri !== `${expected.origin}${CHALLENGE_PATH}` ||
      parsed.chainId !== expected.chainId || parsed.version !== '1' ||
      parsed.statement !== STATEMENT || parsed.nonce !== nonce || !NONCE.test(nonce) ||
      !parsed.address || !parsed.issuedAt || !parsed.expirationTime ||
      parsed.notBefore !== undefined || parsed.requestId !== undefined ||
      !Array.isArray(parsed.resources) ||
      JSON.stringify(parsed.resources) !== JSON.stringify([registrationResource()])) invalidChallenge();
  let messageAddress: string;
  try { messageAddress = getAddress(parsed.address).toLowerCase(); } catch { invalidChallenge(); }
  if (messageAddress !== address.toLowerCase() ||
      !Number.isFinite(parsed.issuedAt.getTime()) ||
      !Number.isFinite(parsed.expirationTime.getTime()) ||
      parsed.expirationTime.getTime() - parsed.issuedAt.getTime() !== CHALLENGE_TTL_MS ||
      parsed.issuedAt.getTime() > Date.now() + 30_000 ||
      parsed.expirationTime.getTime() - Date.now() <= 5_000 ||
      expiresAt !== parsed.expirationTime.toISOString()) invalidChallenge();
  const canonical = createSiweMessage({
    scheme: 'https', domain: expected.domain, uri: `${expected.origin}${CHALLENGE_PATH}`,
    address: messageAddress as `0x${string}`, chainId: expected.chainId, version: '1',
    nonce, issuedAt: parsed.issuedAt, expirationTime: parsed.expirationTime,
    statement: STATEMENT, resources: [registrationResource()],
  });
  if (canonical !== message) invalidChallenge();
  return { message, expiresAtMs: parsed.expirationTime.getTime() };
}

/** Prepare one fixed Voidly registration mutation; this never submits it. */
export async function prepareVoidlySellerRegistration(input: {
  network: BaseNetwork;
  address: `0x${string}`;
  allowedOrigins: readonly string[];
  signer: ClientEvmSigner;
  fetcher: typeof fetch;
}): Promise<PreparedVoidlySellerRegistration> {
  const { origin } = ORIGINS[input.network];
  if (!input.allowedOrigins.includes(origin)) {
    throw new Error('Voidly seller registration origin is not allowed');
  }
  const signer = input.signer as ClientEvmSigner & {
    signMessage?: (args: { message: string }) => Promise<`0x${string}`>;
  };
  if (typeof signer.signMessage !== 'function') {
    throw new Error('Voidly seller registration requires an EIP-191 signer');
  }
  const challengeUrl = `${origin}${CHALLENGE_PATH}`;
  let response: Response;
  try {
    response = await input.fetcher(challengeUrl, {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ wallet: input.address, action: 'register', payload: {} }),
    });
  } catch { throw new Error('Voidly seller registration challenge is unavailable'); }
  if (response.url && response.url !== challengeUrl) invalidChallenge();
  const { message, expiresAtMs } = checkedMessage(await boundedJson(response), input.network, input.address);
  let signature: `0x${string}`;
  try { signature = await signer.signMessage({ message }); }
  catch { throw new Error('Voidly seller registration signing failed'); }
  if (Date.now() >= expiresAtMs) invalidChallenge();
  if (!SIGNATURE.test(signature)) throw new Error('Voidly seller registration signature is invalid');
  let recovered: `0x${string}`;
  try { recovered = await recoverMessageAddress({ message, signature }); }
  catch { throw new Error('Voidly seller registration signature is invalid'); }
  if (recovered.toLowerCase() !== input.address.toLowerCase()) {
    throw new Error('Voidly seller registration signature is invalid');
  }
  return {
    submitUrl: `${origin}${REGISTER_PATH}`,
    body: { payload: {}, message, signature },
  };
}
