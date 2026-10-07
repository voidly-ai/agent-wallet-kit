import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import nacl from 'tweetnacl';
import { readVoidlyCapabilities } from './voidlyCapabilities.js';

const API_ORIGIN = 'https://api.voidly.ai';
const MAIL_PATH = '/mcp/mail';
const DID = /^did:voidly:[1-9A-HJ-NP-Za-km-z]{1,32}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const IDEMPOTENCY_KEY = /^[0-9a-f]{32}$/;
const MAIL_KEY = /^vm_[0-9a-f]{64}$/;
const BOUNTY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOUNTY_SCHEMA = 'voidly-bounty-mvp/v1';
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 1_000_000;

export const AGENT_CLI_USAGE = `voidly-agent-wallet home
voidly-agent-wallet capabilities
voidly-agent-wallet board post --input post.json
voidly-agent-wallet board bid <job-id> --input bid.json
voidly-agent-wallet board award <job-id> --input award.json
voidly-agent-wallet jobs
voidly-agent-wallet jobs show <job-id>
voidly-agent-wallet jobs create --input job.json
voidly-agent-wallet bounty list
voidly-agent-wallet bounty show <bounty-id>
voidly-agent-wallet bounty claim <bounty-id> --input claim.json
voidly-agent-wallet bounty submit <bounty-id> --input submission.json
voidly-agent-wallet mail inbox [--limit 1..10] [--offset 0..1000] [--unread-only]
voidly-agent-wallet mail read <email-id>
voidly-agent-wallet mail send --input message.json
voidly-agent-wallet mail status <operation-id>

Home requires VOIDLY_HOME_ROOT_DID and VOIDLY_HOME_ROOT_SIGNING_SECRET_BASE64.
Board and job writes require VOIDLY_AGENT_DID and VOIDLY_AGENT_SIGNING_SECRET_BASE64.
Bounty claim and submit use the same agent credentials and a saved idempotency_key in the input JSON.
Bounty rewards are advertised and unfunded; payouts remain owner-run and off.
Mail requires VOIDLY_MAIL_AGENT_KEY, an owner-provisioned vm_ agent key. Keep all secrets in a secret manager, never on the command line.
Mail send requires a caller-saved operationId in message.json; check mail status with the same ID after uncertainty.`;

export interface AgentCliDependencies {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

type CliArgs = { command: string; action: string | null; positional: string[]; flags: Map<string, string> };
type Credentials = { did: string; secretKey: Uint8Array };

export function isAgentCliCommand(command: string | undefined): boolean {
  return command === 'home' || command === 'capabilities' || command === 'board' ||
    command === 'jobs' || command === 'mail' || command === 'bounty';
}

function parse(argv: string[]): CliArgs {
  const command = argv[0]!;
  let action: string | null = null;
  let start = 1;
  if (command === 'board' || command === 'mail' || command === 'bounty' || command === 'jobs' && argv[1] && !argv[1].startsWith('--')) {
    action = argv[1] ?? null;
    start = 2;
  }
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = start; i < argv.length; i++) {
    const part = argv[i]!;
    if (!part.startsWith('--')) { positional.push(part); continue; }
    const key = part.slice(2);
    if (flags.has(key)) throw new Error(`Repeated option: --${key}`);
    if (key === 'unread-only') { flags.set(key, 'true'); continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
  }
  const spec: Record<string, { actions: string[]; flags: string[]; positional: number }> = {
    home: { actions: [''], flags: [], positional: 0 },
    capabilities: { actions: [''], flags: [], positional: 0 },
    'board:post': { actions: ['post'], flags: ['input'], positional: 0 },
    'board:bid': { actions: ['bid'], flags: ['input'], positional: 1 },
    'board:award': { actions: ['award'], flags: ['input'], positional: 1 },
    jobs: { actions: [''], flags: [], positional: 0 },
    'jobs:show': { actions: ['show'], flags: [], positional: 1 },
    'jobs:create': { actions: ['create'], flags: ['input'], positional: 0 },
    'bounty:list': { actions: ['list'], flags: [], positional: 0 },
    'bounty:show': { actions: ['show'], flags: [], positional: 1 },
    'bounty:claim': { actions: ['claim'], flags: ['input'], positional: 1 },
    'bounty:submit': { actions: ['submit'], flags: ['input'], positional: 1 },
    'mail:inbox': { actions: ['inbox'], flags: ['limit', 'offset', 'unread-only'], positional: 0 },
    'mail:read': { actions: ['read'], flags: [], positional: 1 },
    'mail:send': { actions: ['send'], flags: ['input'], positional: 0 },
    'mail:status': { actions: ['status'], flags: [], positional: 1 },
  };
  const key = action ? `${command}:${action}` : command;
  const selected = spec[key];
  if (!selected || !selected.actions.includes(action ?? '') || positional.length !== selected.positional ||
      [...flags.keys()].some(flag => !selected.flags.includes(flag)) ||
      selected.flags.includes('input') && !flags.has('input')) throw new Error(AGENT_CLI_USAGE);
  return { command, action, positional, flags };
}

function requiredCredentials(env: NodeJS.ProcessEnv, kind: 'home' | 'agent'): Credentials {
  const did = kind === 'home' ? env.VOIDLY_HOME_ROOT_DID : env.VOIDLY_AGENT_DID;
  const encoded = kind === 'home' ? env.VOIDLY_HOME_ROOT_SIGNING_SECRET_BASE64 : env.VOIDLY_AGENT_SIGNING_SECRET_BASE64;
  if (!did || !DID.test(did) || !encoded) throw new Error(`${kind} DID and signing secret are required from the secret manager`);
  const secretKey = Buffer.from(encoded, 'base64');
  if (secretKey.length !== 64 || secretKey.toString('base64') !== encoded ||
      !Buffer.from(nacl.sign.keyPair.fromSeed(secretKey.subarray(0, 32)).publicKey).equals(secretKey.subarray(32))) {
    throw new Error(`Invalid ${kind} signing secret`);
  }
  return { did, secretKey };
}

function signedHeaders(kind: 'home' | 'board' | 'job', method: 'GET' | 'POST', path: string,
  body: string | null, env: NodeJS.ProcessEnv): Headers {
  const { did, secretKey } = requiredCredentials(env, kind === 'home' ? 'home' : 'agent');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const hash = body === null ? null : createHash('sha256').update(body, 'utf8').digest('hex');
  const domain = kind === 'home' ? 'voidly-home-read-v1' :
    kind === 'board' ? 'voidly-board-post-v1' : 'voidly-agent-job-v1';
  const message = [domain, method, path, did, timestamp, nonce, ...(hash === null ? [] : [hash])].join('\n');
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString('base64');
  const prefix = kind === 'home' ? 'Home' : kind === 'board' ? 'Board' : 'Job';
  return new Headers({ 'X-Agent-DID': did, [`X-${prefix}-Timestamp`]: timestamp,
    [`X-${prefix}-Nonce`]: nonce, [`X-${prefix}-Signature`]: signature });
}

async function inputFile(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REQUEST_BYTES) {
      throw new Error('Input must be a regular JSON file of at most 8192 bytes');
    }
    bytes = await file.readFile();
  } finally { await file.close(); }
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new Error('Input is too large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Input must contain UTF-8 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input must be a JSON object');
  return { text: new TextDecoder().decode(bytes), value: value as Record<string, unknown> };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error('Response exceeds the size limit');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Response is not JSON');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the size limit');
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scrub(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 12) return '[redacted: depth limit]';
  if (typeof value === 'string') {
    let clean = value.replace(/vmo?_[0-9a-f]{8,64}/gi, '[redacted: Voidmail key]');
    for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, '[redacted: credential]');
    return clean;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets, depth + 1));
  if (!object(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:secret|private.?key|owner.?key|api.?key|authorization|cookie|credential|token)/i.test(key)) continue;
    output[key] = scrub(item, secrets, depth + 1);
  }
  return output;
}

function statusFor(httpStatus: number): 'unavailable' | 'refused' | 'conflict' | 'failed' {
  return httpStatus === 404 || httpStatus === 503 || httpStatus === 502 ? 'unavailable' :
    httpStatus === 401 || httpStatus === 403 ? 'refused' : httpStatus === 409 ? 'conflict' : 'failed';
}

function safeCode(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  const nested = object(value.error) ? value.error.code : value.error ?? value.code;
  return typeof nested === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(nested) ? nested : undefined;
}

async function apiRequest(path: string, method: 'GET' | 'POST', fetcher: typeof fetch,
  headers = new Headers(), body: string | null = null): Promise<{
    httpStatus: number; value: unknown; ambiguous?: boolean; invalidResponse?: boolean
  }> {
  const url = `${API_ORIGIN}${path}`;
  headers.set('Accept', 'application/json');
  if (body !== null) headers.set('Content-Type', 'application/json');
  const response = await fetcher(url, { method, headers, ...(body === null ? {} : { body }),
    redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(method === 'POST' ? 20_000 : 10_000) });
  if (response.redirected || response.url && response.url !== url || response.status >= 300 && response.status < 400) {
    return { httpStatus: response.status, value: { code: 'redirect_refused' }, ambiguous: method === 'POST' };
  }
  try { return { httpStatus: response.status, value: await boundedJson(response) }; }
  catch { return { httpStatus: response.status, value: { code: 'invalid_response' },
    ambiguous: method === 'POST' && response.ok, invalidResponse: true }; }
}

async function homeSnapshot(fetcher: typeof fetch, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const path = '/v1/home/me';
  const reply = await apiRequest(path, 'GET', fetcher, signedHeaders('home', 'GET', path, null, env));
  if (reply.httpStatus !== 200) return { command: 'home', status: statusFor(reply.httpStatus),
    httpStatus: reply.httpStatus, code: safeCode(reply.value) ?? 'home_unavailable' };
  if (!object(reply.value) || reply.value.version !== 'home.me.v1' || !object(reply.value.home)) {
    return { command: 'home', status: 'unavailable', code: 'invalid_home_response' };
  }
  return { command: 'home', status: 'ready', snapshot: scrub(reply.value, [env.VOIDLY_HOME_ROOT_SIGNING_SECRET_BASE64 ?? '']) };
}

async function writeAgent(path: string, domain: 'board' | 'job', command: string, action: string,
  input: { text: string; value: Record<string, unknown> }, fetcher: typeof fetch,
  env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const headers = signedHeaders(domain, 'POST', path, input.text, env);
  const idempotencyKey = typeof input.value.idempotency_key === 'string' && IDEMPOTENCY_KEY.test(input.value.idempotency_key)
    ? input.value.idempotency_key : undefined;
  try {
    const reply = await apiRequest(path, 'POST', fetcher, headers, input.text);
    if (reply.ambiguous || reply.httpStatus >= 500) return { command, action,
      status: 'outcome_unknown', httpStatus: reply.httpStatus, doNotRetry: true,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      next: 'Inspect the original operation before any retry; do not assume the write failed.' };
    if (reply.httpStatus !== 200 && reply.httpStatus !== 201) return { command, action,
      status: statusFor(reply.httpStatus), httpStatus: reply.httpStatus,
      code: safeCode(reply.value) ?? 'request_not_accepted', ...(idempotencyKey ? { idempotencyKey } : {}) };
    const expectedField = action === 'post' ? 'post' : action === 'create' ? 'job' :
      action === 'bid' ? 'bid' : 'award';
    if (!object(reply.value) || !object(reply.value[expectedField])) return { command, action, status: 'outcome_unknown', doNotRetry: true,
      ...(idempotencyKey ? { idempotencyKey } : {}) };
    return { command, action, status: 'accepted', httpStatus: reply.httpStatus,
      result: scrub(reply.value, [env.VOIDLY_AGENT_SIGNING_SECRET_BASE64 ?? '']),
      ...(action === 'award' ? { paymentStatus: 'unpaid_or_unverified' } : {}) };
  } catch {
    return { command, action, status: 'outcome_unknown', doNotRetry: true,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      next: 'Inspect the original operation before any retry; do not assume the write failed.' };
  }
}

/** B411 has public reads and signed intake only; no funded or paid response is supported. */
function publicBounty(value: unknown): Record<string, unknown> | null {
  if (!object(value) || typeof value.id !== 'string' || !BOUNTY_ID.test(value.id) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 ||
      Buffer.byteLength(value.title, 'utf8') > 240 ||
      typeof value.instructions !== 'string' || !value.instructions.trim() || value.instructions.length > 2000 ||
      Buffer.byteLength(value.instructions, 'utf8') > 4000 ||
      typeof value.reward_atomic !== 'string' || !/^[1-9][0-9]{0,7}$/.test(value.reward_atomic) ||
      Number(value.reward_atomic) > 10_000_000 || value.reward_currency !== 'USDC' ||
      value.reward_decimals !== 6 || value.reward_status !== 'advertised_unfunded' ||
      !Number.isSafeInteger(value.expires_at_ms) || Number(value.expires_at_ms) < 0 ||
      typeof value.status !== 'string' || !['open', 'claimed', 'submitted', 'owner_accepted'].includes(value.status) ||
      typeof value.claimable !== 'boolean' || value.claimable && value.status !== 'open' ||
      value.payable !== false || value.paid !== false || value.payout_status !== 'owner_run_off') return null;
  // Allowlist the public view: never print private submission text or unexpected server fields.
  return Object.fromEntries(['id', 'title', 'instructions', 'reward_atomic', 'reward_currency',
    'reward_decimals', 'reward_status', 'expires_at_ms', 'status', 'claimable', 'payable', 'paid',
    'payout_status'].map(key => [key, value[key]]));
}

async function readBounties(action: 'list' | 'show', id: string | undefined, fetcher: typeof fetch,
  env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const base = { command: 'bounty', action };
  try {
    const reply = await apiRequest(id ? `/v1/bounties/${id}` : '/v1/bounties', 'GET', fetcher);
    if (reply.httpStatus !== 200) return { ...base, status: statusFor(reply.httpStatus),
      httpStatus: reply.httpStatus, code: safeCode(reply.value) ?? 'bounties_unavailable' };
    const value = reply.value;
    if (object(value) && value.schema === BOUNTY_SCHEMA) {
      const items = action === 'list' && Array.isArray(value.tasks) && value.tasks.length <= 20
        ? value.tasks.map(publicBounty) : null;
      const detail = action === 'show' ? publicBounty(value) : null;
      if (items && items.every(item => item !== null) || detail && detail.id === id) {
        return { ...base, status: 'ready', source: BOUNTY_SCHEMA,
          ...(items ? { limit: 20, tasks: scrub(items, [env.VOIDLY_AGENT_SIGNING_SECRET_BASE64 ?? '']) } :
            { result: scrub(detail, [env.VOIDLY_AGENT_SIGNING_SECRET_BASE64 ?? '']) }),
          warning: 'Rewards are advertised and unfunded. Payouts are owner-run and off.' };
      }
    }
    return { ...base, status: 'unavailable', code: 'unsupported_bounty_response' };
  } catch {
    return { ...base, status: 'unavailable', code: 'bounties_unavailable' };
  }
}

async function bountyCommand(action: string, id: string | undefined, flags: Map<string, string>,
  fetcher: typeof fetch, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  if (id && !BOUNTY_ID.test(id)) throw new Error('Invalid bounty ID: expected a lowercase UUID');
  if (action === 'list' || action === 'show') return readBounties(action, id, fetcher, env);
  const input = await inputFile(flags.get('input')!);
  const expectedKeys = action === 'claim' ? 'idempotency_key' : 'idempotency_key,result_text';
  if (Object.keys(input.value).sort().join(',') !== expectedKeys ||
      typeof input.value.idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(input.value.idempotency_key) ||
      action === 'submit' && (typeof input.value.result_text !== 'string' || !input.value.result_text.trim() ||
        input.value.result_text.length > 4096 || Buffer.byteLength(input.value.result_text, 'utf8') > 4096)) {
    throw new Error('Bounty input requires a saved 32-character lowercase hex idempotency_key; submit also requires result_text of 1..4096 UTF-8 bytes. No other fields are accepted.');
  }
  const base = { command: 'bounty', action, bountyId: id,
    idempotencyKey: input.value.idempotency_key, automaticRetry: false };
  // Probe the actual B411 read contract without credentials before signing any write.
  // Do not gate on claimable/current state: exact-body replay may recover a completed write.
  const available = await readBounties('list', undefined, fetcher, env);
  if (available.status !== 'ready') return { ...available, ...base, writeDispatched: false };
  const path = `/v1/bounties/${id}/${action}`;
  const headers = signedHeaders('job', 'POST', path, input.text, env);
  const unknown = { ...base, status: 'outcome_unknown', retrySameInputOnly: true,
    next: 'Keep the original input file. Inspect bounty show, then explicitly rerun the same action, bounty ID, and exact file to recover the saved response. Never change the idempotency key or payload after uncertainty.' };
  try {
    const reply = await apiRequest(path, 'POST', fetcher, headers, input.text);
    // This route rejects the kill switch before authentication or storage mutation.
    if (reply.httpStatus === 503 && safeCode(reply.value) === 'bounties_stopped') {
      return { ...base, status: 'unavailable', httpStatus: 503, code: 'bounties_stopped' };
    }
    if (reply.ambiguous || reply.httpStatus >= 500) return { ...unknown, httpStatus: reply.httpStatus };
    if (reply.httpStatus >= 200 && reply.httpStatus < 300 && reply.httpStatus !== 200) {
      return { ...unknown, httpStatus: reply.httpStatus };
    }
    if (reply.httpStatus !== 200) return { ...base, status: statusFor(reply.httpStatus),
      httpStatus: reply.httpStatus, code: safeCode(reply.value) ?? 'bounty_request_not_accepted' };
    const result = object(reply.value) && reply.value.schema === BOUNTY_SCHEMA ? publicBounty(reply.value) : null;
    if (!result || result.id !== id || result.status !== (action === 'claim' ? 'claimed' : 'submitted')) return unknown;
    return { ...base, status: 'accepted', httpStatus: 200,
      result: scrub(result, [env.VOIDLY_AGENT_SIGNING_SECRET_BASE64 ?? '']),
      paymentStatus: 'advertised_unfunded', payable: false, paid: false, payoutStatus: 'owner_run_off' };
  } catch { return unknown; }
}

function numberFlag(flags: Map<string, string>, key: string, min: number, max: number, fallback: number): number {
  const raw = flags.get(key);
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  return value;
}

async function mailCall(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv,
  fetcher: typeof fetch, operationId?: string): Promise<Record<string, unknown>> {
  const key = env.VOIDLY_MAIL_AGENT_KEY;
  if (!key || !MAIL_KEY.test(key)) throw new Error('VOIDLY_MAIL_AGENT_KEY must be an owner-provisioned Voidmail agent key');
  const send = name === 'voidmail_send_once';
  const url = `${API_ORIGIN}${MAIL_PATH}`;
  const requestId = randomUUID();
  const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call',
    params: { name, arguments: args } });
  try {
    const response = await fetcher(url, { method: 'POST', redirect: 'manual', credentials: 'omit',
      cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` }, body });
    if (response.redirected || response.url && response.url !== url || response.status >= 300 && response.status < 400) {
      return { status: send ? 'outcome_unknown' : 'unavailable', code: 'redirect_refused',
        ...(operationId ? { operationId, automaticRetry: false } : {}) };
    }
    let rpc: unknown;
    try { rpc = await boundedJson(response); }
    catch { return { status: send ? 'outcome_unknown' : 'unavailable', code: 'invalid_response',
      ...(operationId ? { operationId, automaticRetry: false } : {}) }; }
    if (!object(rpc) || rpc.jsonrpc !== '2.0' || rpc.id !== requestId) return {
      status: send ? 'outcome_unknown' : 'unavailable', code: 'invalid_response',
      ...(operationId ? { operationId, automaticRetry: false } : {}),
    };
    if (response.status !== 200 || object(rpc.error)) {
      const error = object(rpc.error) ? rpc.error : {};
      const code = safeCode(error) ?? (typeof error.message === 'string' && /^[A-Z_]{1,80}$/.test(error.message)
        ? error.message : 'mail_unavailable');
      return { status: send ? 'outcome_unknown' : statusFor(response.status), code,
        httpStatus: response.status, ...(operationId ? { operationId, automaticRetry: false,
          next: 'Check mail status with the same operation ID; never send under a new ID after uncertainty.' } : {}) };
    }
    const result = rpc.result;
    if (!object(result)) return { status: send ? 'outcome_unknown' : 'unavailable', code: 'invalid_mail_result',
      ...(operationId ? { operationId, automaticRetry: false } : {}) };
    let payload: unknown = result.structuredContent;
    if (!object(payload)) {
      const content = result.content;
      if (!Array.isArray(content) || !object(content[0]) || typeof content[0].text !== 'string') {
        return { status: send ? 'outcome_unknown' : 'unavailable', code: 'invalid_mail_result',
          ...(operationId ? { operationId, automaticRetry: false } : {}) };
      }
      try { payload = JSON.parse(content[0].text); }
      catch { return { status: send ? 'outcome_unknown' : 'unavailable', code: 'invalid_mail_result',
        ...(operationId ? { operationId, automaticRetry: false } : {}) }; }
    }
    const safe = scrub(payload, [key]);
    if (send) {
      const state = object(payload) && typeof payload.status === 'string' &&
        !(result.isError === true && payload.status === 'accepted') ? payload.status : 'outcome_unknown';
      return { status: state === 'accepted' ? 'accepted' : state,
        operationId, providerAccepted: state === 'accepted', deliveryConfirmed: false,
        automaticRetry: false, result: safe,
        ...(state === 'accepted' ? {} : { next: 'Check mail status with the same operation ID.' }) };
    }
    if (name === 'voidmail_send_status') {
      const state = object(payload) && typeof payload.status === 'string' ? payload.status :
        result.isError === true ? 'unavailable' : 'unknown';
      return { status: state, operationId, automaticRetry: false,
        providerAccepted: state === 'accepted', deliveryConfirmed: false, result: safe };
    }
    return { status: result.isError === true ? 'refused' : 'ready', result: safe };
  } catch {
    return { status: send ? 'outcome_unknown' : 'unavailable', code: 'mail_request_unavailable',
      ...(operationId ? { operationId, automaticRetry: false,
        next: 'Check mail status with the same operation ID; never send under a new ID after uncertainty.' } : {}) };
  }
}

/** One CLI entry point for fixed first-party agent surfaces; tests inject inert transport. */
export async function runAgentCli(argv: string[], dependencies: AgentCliDependencies = {}): Promise<Record<string, unknown>> {
  const { command, action, positional, flags } = parse(argv);
  const fetcher = dependencies.fetcher ?? fetch;
  const env = dependencies.env ?? process.env;
  if (command === 'bounty') return bountyCommand(action!, positional[0], flags, fetcher, env);
  if (command === 'capabilities') return { command, ...(await readVoidlyCapabilities(fetcher)) };
  if (command === 'home') return homeSnapshot(fetcher, env);
  if (command === 'jobs' && action === null) {
    const home = await homeSnapshot(fetcher, env);
    if (home.status !== 'ready') return { ...home, command: 'jobs' };
    const snapshot = home.snapshot as { observed_at?: unknown; home: Record<string, unknown> };
    return { command: 'jobs', status: 'ready', source: 'home.me.v1', observedAt: snapshot.observed_at,
      jobs: snapshot.home.jobs };
  }
  if (command === 'jobs' && action === 'show') {
    const id = positional[0]!;
    if (!RESOURCE_ID.test(id)) throw new Error('Invalid job ID');
    const path = `/v1/agent/jobs/${id}`;
    const headers = env.VOIDLY_AGENT_DID || env.VOIDLY_AGENT_SIGNING_SECRET_BASE64
      ? signedHeaders('job', 'GET', path, '', env) : new Headers();
    const reply = await apiRequest(path, 'GET', fetcher, headers);
    return reply.httpStatus === 200 && !reply.invalidResponse && object(reply.value) && object(reply.value.job)
      ? { command: 'jobs', action, status: 'ready',
      result: scrub(reply.value, [env.VOIDLY_AGENT_SIGNING_SECRET_BASE64 ?? '']) } :
      { command: 'jobs', action, status: reply.httpStatus === 200 ? 'unavailable' : statusFor(reply.httpStatus), httpStatus: reply.httpStatus,
        code: safeCode(reply.value) ?? 'job_unavailable' };
  }
  if (command === 'board' || command === 'jobs' && action === 'create') {
    const input = await inputFile(flags.get('input')!);
    if (command === 'jobs' && !IDEMPOTENCY_KEY.test(String(input.value.idempotency_key ?? '')) ||
        command === 'board' && action !== 'post' && !IDEMPOTENCY_KEY.test(String(input.value.idempotency_key ?? ''))) {
      throw new Error('A 32-character lowercase hex idempotency_key is required in the input JSON');
    }
    const id = positional[0];
    if (id && !RESOURCE_ID.test(id)) throw new Error('Invalid job ID');
    const path = command === 'jobs' ? '/v1/agent/jobs' : action === 'post'
      ? '/v1/agent/board/posts' : `/v1/agent/jobs/${id}/${action === 'bid' ? 'bids' : 'award'}`;
    return writeAgent(path, action === 'post' ? 'board' : 'job', command, action!, input, fetcher, env);
  }
  if (command === 'mail') {
    if (action === 'inbox') return { command, action, ...(await mailCall('voidmail_list_inbox', {
      limit: numberFlag(flags, 'limit', 1, 10, 10), offset: numberFlag(flags, 'offset', 0, 1000, 0),
      unreadOnly: flags.has('unread-only'),
    }, env, fetcher)) };
    if (action === 'read') {
      const id = positional[0]!;
      if (!RESOURCE_ID.test(id)) throw new Error('Invalid email ID');
      return { command, action, ...(await mailCall('voidmail_read_email', { emailId: id }, env, fetcher)) };
    }
    if (action === 'status') {
      const id = positional[0]!;
      if (!OPERATION_ID.test(id)) throw new Error('Invalid mail operation ID');
      return { command, action, ...(await mailCall('voidmail_send_status', { operationId: id }, env, fetcher, id)) };
    }
    const input = await inputFile(flags.get('input')!);
    const value = input.value;
    if (Object.keys(value).sort().join(',') !== 'operationId,subject,text,to' ||
        !OPERATION_ID.test(String(value.operationId ?? '')) || typeof value.to !== 'string' ||
        !value.to.includes('@') || /[\r\n]/.test(value.to) || value.to.length > 254 ||
        typeof value.subject !== 'string' || !value.subject.trim() || value.subject.length > 200 || /[\r\n]/.test(value.subject) ||
        typeof value.text !== 'string' || !value.text || Buffer.byteLength(value.text, 'utf8') > 8192) {
      throw new Error('Mail input requires operationId, to, subject, and bounded plain text');
    }
    return { command, action, ...(await mailCall('voidmail_send_once', value, env, fetcher, value.operationId as string)) };
  }
  throw new Error(AGENT_CLI_USAGE);
}
