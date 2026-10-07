import { z } from 'zod';

export const VOIDLY_CAPABILITIES_URL = 'https://voidly.ai/.well-known/voidly.json';

const MAX_MANIFEST_BYTES = 1_000_000;
const backendStatusSchema = z.union([z.boolean(), z.string().min(1).max(128)]);

const endpointSchema = z.object({
  method: z.string().regex(/^[A-Z]{3,8}$/),
  url: z.string().min(1).max(2_048).refine(value => value.startsWith('https://') || value.startsWith('npm:@voidly/')),
  backend_available: backendStatusSchema.optional(),
}).passthrough();

const actionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  availability: z.string().min(1).max(128),
  callable: z.boolean().optional(),
  endpoint: endpointSchema.extend({ backend_available: backendStatusSchema }),
  relatedEndpoints: z.array(endpointSchema).max(200).optional(),
  auth: z.object({ kind: z.string().min(1).max(128) }).passthrough().optional(),
  price: z.object({ mode: z.string().min(1).max(128) }).passthrough().optional(),
}).passthrough();

const manifestSchema = z.object({
  schema: z.literal('voidly.agent-capabilities/v1'),
  revision: z.string().min(1).max(128),
  sourceBase: z.string().min(1).max(256),
  sourceStatus: z.string().min(1).max(128),
  coverage: z.object({
    status: z.string().min(1).max(128),
    exhaustive: z.boolean(),
    note: z.string().max(1_024).optional(),
  }).passthrough(),
  actions: z.array(actionSchema).min(1).max(500),
}).passthrough();

async function boundedBody(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_MANIFEST_BYTES)) {
    throw new Error('Voidly capability manifest exceeds the size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Voidly capability manifest has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_MANIFEST_BYTES) throw new Error('Voidly capability manifest exceeds the size limit');
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new Error('Voidly capability manifest is not valid UTF-8 JSON');
  }
}

/** Read the public manifest. Its coverage and per-route status remain publisher claims, not live-route proof. */
export async function readVoidlyCapabilities(fetcher: typeof fetch = fetch) {
  const response = await fetcher(VOIDLY_CAPABILITIES_URL, {
    method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 || response.redirected || response.url && response.url !== VOIDLY_CAPABILITIES_URL) {
    throw new Error(`Voidly capability manifest unavailable (HTTP ${response.status}); no verified capability list`);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Voidly capability manifest did not return JSON');
  }
  const parsed = manifestSchema.safeParse(await boundedBody(response));
  if (!parsed.success) throw new Error('Voidly capability manifest failed v1 schema validation');
  const ids = parsed.data.actions.map(action => action.id);
  if (new Set(ids).size !== ids.length) throw new Error('Voidly capability manifest has duplicate action IDs');
  return {
    manifestUrl: VOIDLY_CAPABILITIES_URL,
    ...parsed.data,
    actionCount: parsed.data.actions.length,
    warning: parsed.data.coverage.exhaustive
      ? 'The publisher marks this manifest exhaustive, but each route still needs a current availability check.'
      : 'The publisher marks this manifest partial. Listed routes and source wiring are not proof that their backends are live.',
  };
}
