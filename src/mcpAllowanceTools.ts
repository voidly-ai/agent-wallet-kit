import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { usdToAtomic } from './spend.js';
import { assertSpendAllowanceActive, canonicalSpendAllowanceGrant, canonicalSpendAllowanceJson,
  checkedSpendAllowanceGrant, type SpendAllowanceGrant } from './spendAllowance.js';

export interface SpendAllowanceToolStatus {
  grant: SpendAllowanceGrant;
  status: 'active' | 'revoked' | 'expired' | 'not_yet_active';
  day: string;
  usedAtomic: string;
  remainingAtomic: string;
}

export interface SpendAllowanceToolDependencies {
  /** Explicit approval precedes this callback. Save locally only after exact authoritative readback. */
  grant(grant: SpendAllowanceGrant): Promise<unknown>;
  /** Must read authoritative server status, never synthesize active status from local storage. */
  status(grantId: string): Promise<unknown>;
  /** Disable local delegated use before attempting remote revocation. Keep uncertainty recoverable. */
  revoke(grantId: string): Promise<unknown>;
  /** Return only a durable, locally enabled grant created after explicit owner approval. */
  enabledGrant(grantId: string): Promise<SpendAllowanceGrant | null>;
  /** Uses exact grant route, expected listing/payee, local caps and pre-signature server reservation.
   * Return only safe output; uncertain paid outcomes must return the original recovery identity.
   */
  buy(request: { grant: SpendAllowanceGrant; listingId: string; version: number;
    input: Record<string, unknown>; maxUsdc: string }): Promise<Record<string, unknown>>;
  /** Clock in Unix milliseconds. */
  now?: () => number;
}

const grantIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const listingIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{7,63}$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const grantSchema = z.object({
  version: z.literal('voidpay-spend-allowance/v1'), grantId: grantIdSchema,
  origin: z.enum(['https://x402.voidly.ai', 'https://x402-staging.voidly.ai']),
  network: z.enum(['eip155:8453', 'eip155:84532']), asset: addressSchema,
  owner: addressSchema, payer: addressSchema,
  dailyLimitAtomic: z.string().regex(/^[1-9][0-9]{0,8}$/),
  perCallLimitAtomic: z.string().regex(/^[1-9][0-9]{0,8}$/),
  validAfter: versionSchema, expiresAt: versionSchema,
  listings: z.array(z.object({ listingId: listingIdSchema, version: versionSchema,
    payTo: addressSchema }).strict()).min(1).max(32),
}).strict();
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const confirmation = ' The MCP host must obtain the owner\'s explicit approval of this exact operation before confirm:true. That parameter acknowledges approval; it is not independent human authentication.';
const STATUS_FIELDS = ['grant', 'status', 'day', 'usedAtomic', 'remainingAtomic'];

function output(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value, ...(typeof value.error === 'string' ? { isError: true } : {}) };
}

function safeFailure() {
  return output({ status: 'refused', code: 'allowance_operation_refused',
    error: 'Allowance operation was not completed. Check owner approval, grant status, exact listing, and budget. Never repeat an uncertain purchase; use its original recovery identity.' });
}

function checkedStatus(raw: unknown, grantId: string, expected?: SpendAllowanceGrant): SpendAllowanceToolStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid allowance status');
  canonicalSpendAllowanceJson(raw);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== STATUS_FIELDS.length ||
      Object.keys(value).some(key => !STATUS_FIELDS.includes(key))) throw new Error('Invalid allowance status');
  const grant = checkedSpendAllowanceGrant(value.grant);
  if (grant.grantId !== grantId || expected && canonicalSpendAllowanceGrant(grant) !== canonicalSpendAllowanceGrant(expected) ||
      !['active', 'revoked', 'expired', 'not_yet_active'].includes(String(value.status)) ||
      typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
      !Number.isFinite(Date.parse(`${value.day}T00:00:00.000Z`)) ||
      new Date(`${value.day}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.day ||
      typeof value.usedAtomic !== 'string' || !/^(?:0|[1-9][0-9]{0,8})$/.test(value.usedAtomic) ||
      typeof value.remainingAtomic !== 'string' || !/^(?:0|[1-9][0-9]{0,8})$/.test(value.remainingAtomic) ||
      BigInt(value.usedAtomic) + BigInt(value.remainingAtomic) !== BigInt(grant.dailyLimitAtomic)) {
    throw new Error('Invalid allowance status');
  }
  return { grant, status: value.status as SpendAllowanceToolStatus['status'], day: value.day,
    usedAtomic: value.usedAtomic, remainingAtomic: value.remainingAtomic };
}

/** A separate delegated purchase surface. Existing per-call confirmation tools remain independent. */
export function registerSpendAllowanceTools(server: McpServer, dependencies: SpendAllowanceToolDependencies): void {
  const clock = dependencies.now ?? Date.now;
  server.registerTool('wallet_allowance_grant', {
    description: 'Approve one bounded, revocable USDC allowance for exact listing versions and payees. Daily budget is at most $100, per call at most $10, lifetime at most 30 days. Later wallet_allowance_buy calls within this grant do not need per-call approval.' + confirmation,
    inputSchema: z.object({ grant: grantSchema, confirm: z.literal(true) }).strict(), annotations: write,
  }, async ({ grant: raw, confirm }) => {
    if (confirm !== true) return safeFailure();
    try {
      const grant = checkedSpendAllowanceGrant(raw);
      return output({ ...checkedStatus(await dependencies.grant(grant), grant.grantId, grant) });
    } catch { return safeFailure(); }
  });
  server.registerTool('wallet_allowance_status', {
    description: 'Read authoritative server allowance status and today\'s reserved budget. Does not grant, revoke, reserve or buy.',
    inputSchema: z.object({ grantId: grantIdSchema }).strict(), annotations: read,
  }, async ({ grantId }) => {
    try { return output({ ...checkedStatus(await dependencies.status(grantId), grantId) }); }
    catch { return safeFailure(); }
  });
  server.registerTool('wallet_allowance_revoke', {
    description: 'Disable local delegated use and revoke the original grant on the server. Existing uncertain purchases retain their original recovery identity.' + confirmation,
    inputSchema: z.object({ grantId: grantIdSchema, confirm: z.literal(true) }).strict(), annotations: write,
  }, async ({ grantId, confirm }) => {
    if (confirm !== true) return safeFailure();
    try {
      const status = checkedStatus(await dependencies.revoke(grantId), grantId);
      if (status.status !== 'revoked') return safeFailure();
      return output({ ...status });
    } catch { return safeFailure(); }
  });
  server.registerTool('wallet_allowance_buy', {
    description: 'Buy an exact allowed listing version using a previously owner-approved, locally enabled allowance. Needs no per-call approval. Checks server status and caps, then reserves server budget before signing. An uncertain outcome must use the original quote and payment key for recovery; never call buy again to recover it.',
    inputSchema: z.object({ grantId: grantIdSchema, listingId: listingIdSchema, version: versionSchema,
      input: z.record(z.unknown()),
      maxUsdc: z.string().regex(/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/) }).strict(), annotations: write,
  }, async ({ grantId, listingId, version, input, maxUsdc }) => {
    try {
      canonicalSpendAllowanceJson(input);
      const maximum = usdToAtomic(maxUsdc);
      if (maximum <= 0n) return safeFailure();
      const saved = await dependencies.enabledGrant(grantId);
      if (!saved) return safeFailure();
      const grant = assertSpendAllowanceActive(saved, Math.floor(clock() / 1_000));
      const selected = grant.listings.filter(item => item.listingId === listingId && item.version === version);
      if (grant.grantId !== grantId || selected.length !== 1 || maximum > BigInt(grant.perCallLimitAtomic)) return safeFailure();
      const status = checkedStatus(await dependencies.status(grantId), grantId, grant);
      if (status.status !== 'active' || status.day !== new Date(clock()).toISOString().slice(0, 10) ||
          maximum > BigInt(status.remainingAtomic)) return safeFailure();
      // Recheck the local lifetime after the authoritative lookup. The signing path checks again.
      assertSpendAllowanceActive(grant, Math.floor(clock() / 1_000));
      return output(await dependencies.buy({ grant, listingId, version, input, maxUsdc }));
    } catch { return safeFailure(); }
  });
}

export { checkedStatus as checkedSpendAllowanceToolStatus };
