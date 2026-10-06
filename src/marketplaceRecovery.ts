import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, opendir, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { VerifiedMarketplaceReceipt } from './marketplaceReceiptVerification.js';

export type MarketplaceNetwork = 'eip155:84532' | 'eip155:8453';
export const MARKETPLACE_ORIGINS = [
  'https://x402.voidly.ai',
  'https://x402-staging.voidly.ai',
] as const;
export type MarketplaceOrigin = typeof MARKETPLACE_ORIGINS[number];

/** Keep receipt-key discovery and recovery on one explicitly admitted gateway. */
export function checkedMarketplaceOrigin(value: string): MarketplaceOrigin {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Unsupported marketplace origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
    url.port && url.port !== '443') throw new Error('Unsupported marketplace origin');
  const origin = url.origin;
  if (!MARKETPLACE_ORIGINS.includes(origin as MarketplaceOrigin)) {
    throw new Error('Unsupported marketplace origin');
  }
  return origin as MarketplaceOrigin;
}

/** Public recovery coordinates for one attempted marketplace payment. No key material belongs here. */
export interface MarketplaceAttempt {
  version: 1;
  quoteId: `0x${string}`;
  paymentKey: `0x${string}`;
  wallet: `0x${string}`;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  network: MarketplaceNetwork;
  listingId: string;
  listingVersion: number;
  targetUrl: string;
  quoteUrl: string;
  amountAtomic: string;
  /** SHA-256 of the exact serialized request body bytes, not the gateway's canonical input hash. */
  requestBodySha256: `0x${string}`;
  /** Hash declared by the quote's marketplace intent. */
  quotedInputSha256: `0x${string}`;
  createdAt: string;
}

export interface MarketplaceAttemptStore {
  readonly kind: 'durable' | 'test-memory';
  /** Check active plus quarantined capacity before reserving spend. Save rechecks atomically. */
  ensureCapacity(): Promise<void>;
  /** Commit an attempt once. A second authorization for the same quote must fail. */
  save(record: MarketplaceAttempt): Promise<void>;
  /** Return the newest 1,000 validated active and archived attempts for restart discovery. */
  list(wallet: `0x${string}`, network: MarketplaceNetwork): Promise<MarketplaceAttempt[]>;
  /** Exact quote lookup includes archived terminal records for payer recovery. */
  get(quoteId: `0x${string}`, wallet: `0x${string}`, network: MarketplaceNetwork): Promise<MarketplaceAttempt | null>;
  /** Archive only an independently verified signed terminal outcome. */
  markTerminal(quoteId: `0x${string}`, status: 'delivered' | 'refund_owed', receipt: VerifiedMarketplaceReceipt): Promise<void>;
}

const MAX_ATTEMPTS = 1_000;
const MAX_RECORD_BYTES = 8_192;
const MAX_ARCHIVE_BYTES = 16_384;
const ATTEMPT_DIRECTORY = 'marketplace-attempts-v1';
const ARCHIVE_DIRECTORY = 'marketplace-attempts-v1-archive';
const QUARANTINE_DIRECTORY = 'marketplace-attempts-v1-quarantine';
const RECORD_FIELDS = [
  'version', 'quoteId', 'paymentKey', 'wallet', 'payTo', 'asset', 'network',
  'listingId', 'listingVersion', 'targetUrl', 'quoteUrl', 'amountAtomic',
  'requestBodySha256', 'quotedInputSha256', 'createdAt',
] as const;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FILE_NAME = /^0x[0-9a-f]{64}\.json$/;
const LISTING_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const decoder = new TextDecoder('utf-8', { fatal: true });
const TERMINAL_STATUSES = ['delivered', 'refund_owed'] as const;
class MarketplaceLockUnavailable extends Error {}
const RECEIPT_FIELDS = [
  'version', 'keyVersion', 'network', 'asset', 'transactionHash', 'payerWallet',
  'payTo', 'amountAtomic', 'resourceUrl', 'context', 'blockNumber',
  'confirmationsAtDelivery', 'listingId', 'listingVersion',
  'inputSha256', 'outputSha256', 'deliveredAt', 'status', 'quoteId',
  'quoteExpiresAt', 'paymentKey', 'outputSchemaMatched', 'failureCode', 'outcomeAt',
  'signature',
] as const;

function checkedNetwork(network: unknown): MarketplaceNetwork {
  if (network !== 'eip155:84532' && network !== 'eip155:8453') {
    throw new Error('Unsupported marketplace network');
  }
  return network;
}

function checkedWallet(wallet: unknown): `0x${string}` {
  if (typeof wallet !== 'string' || !ADDRESS.test(wallet)) throw new Error('Invalid marketplace wallet address');
  return wallet as `0x${string}`;
}

function checkedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new Error('Invalid marketplace attempt URL');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid marketplace attempt URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Invalid marketplace attempt URL');
  }
  return value;
}

/** Validate again after reading disk; corrupted records must never become recovery hints. */
function checkedRecord(input: unknown): MarketplaceAttempt {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid marketplace attempt record');
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== RECORD_FIELDS.length || keys.some(key => !RECORD_FIELDS.includes(key as typeof RECORD_FIELDS[number]))) {
    throw new Error('Invalid marketplace attempt record');
  }
  if (value.version !== 1 || typeof value.quoteId !== 'string' || !HEX_32.test(value.quoteId) ||
    typeof value.paymentKey !== 'string' || !HEX_32.test(value.paymentKey) ||
    typeof value.payTo !== 'string' || !ADDRESS.test(value.payTo) ||
    typeof value.asset !== 'string' || !ADDRESS.test(value.asset) ||
    typeof value.listingId !== 'string' || !LISTING_ID.test(value.listingId) ||
    typeof value.listingVersion !== 'number' || !Number.isSafeInteger(value.listingVersion) || value.listingVersion < 1 ||
    typeof value.amountAtomic !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value.amountAtomic) ||
    BigInt(value.amountAtomic) > UINT256_MAX ||
    typeof value.requestBodySha256 !== 'string' || !HEX_32.test(value.requestBodySha256) ||
    typeof value.quotedInputSha256 !== 'string' || !HEX_32.test(value.quotedInputSha256) ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error('Invalid marketplace attempt record');
  }
  const wallet = checkedWallet(value.wallet);
  const network = checkedNetwork(value.network);
  const targetUrl = checkedUrl(value.targetUrl);
  const quoteUrl = checkedUrl(value.quoteUrl);
  const origin = checkedMarketplaceOrigin(targetUrl);
  if (origin === 'https://x402-staging.voidly.ai' && network !== 'eip155:84532') {
    throw new Error('Marketplace staging requires Base Sepolia');
  }
  const expectedTarget = `${origin}/v1/services/${value.listingId}/call`;
  if (targetUrl !== expectedTarget || quoteUrl !== `${expectedTarget}?quote=${value.quoteId}`) {
    throw new Error('Marketplace attempt quote URL does not match listing and quote ID');
  }
  return {
    version: 1,
    quoteId: value.quoteId as `0x${string}`,
    paymentKey: value.paymentKey as `0x${string}`,
    wallet,
    payTo: value.payTo as `0x${string}`,
    asset: value.asset as `0x${string}`,
    network,
    listingId: value.listingId,
    listingVersion: value.listingVersion,
    targetUrl,
    quoteUrl,
    amountAtomic: value.amountAtomic,
    requestBodySha256: value.requestBodySha256 as `0x${string}`,
    quotedInputSha256: value.quotedInputSha256 as `0x${string}`,
    createdAt: value.createdAt,
  };
}

function privateRegularFile(stat: Stats, maxBytes = MAX_RECORD_BYTES): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    stat.uid === process.getuid?.() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes;
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    stat.uid === process.getuid?.();
}

function quoteFileName(quoteId: string): string {
  if (!HEX_32.test(quoteId)) throw new Error('Invalid marketplace quote ID');
  return `${quoteId.toLowerCase()}.json`;
}

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

interface TerminalArchive {
  version: 1;
  status: 'delivered' | 'refund_owed';
  archivedAt: string;
  attempt: MarketplaceAttempt;
  receipt: VerifiedMarketplaceReceipt;
}

function checkedArchive(input: unknown, name: string): TerminalArchive {
  if (!exactFields(input, ['version', 'status', 'archivedAt', 'attempt', 'receipt']) ||
    input.version !== 1 || !TERMINAL_STATUSES.includes(input.status as TerminalArchive['status']) ||
    typeof input.archivedAt !== 'string' || !Number.isFinite(Date.parse(input.archivedAt)) ||
    new Date(input.archivedAt).toISOString() !== input.archivedAt) {
    throw new Error('Invalid marketplace terminal archive');
  }
  const attempt = checkedRecord(input.attempt);
  if (quoteFileName(attempt.quoteId) !== name || !exactFields(input.receipt, RECEIPT_FIELDS)) {
    throw new Error('Invalid marketplace terminal archive');
  }
  const receipt = input.receipt as unknown as VerifiedMarketplaceReceipt;
  if (receipt.status !== input.status || receipt.quoteId !== attempt.quoteId.toLowerCase() ||
    receipt.paymentKey !== attempt.paymentKey.toLowerCase() ||
    receipt.payerWallet !== attempt.wallet.toLowerCase() ||
    receipt.payTo !== attempt.payTo.toLowerCase() || receipt.asset !== attempt.asset.toLowerCase() ||
    receipt.network !== attempt.network || receipt.amountAtomic !== attempt.amountAtomic ||
    receipt.resourceUrl !== attempt.quoteUrl || receipt.listingId !== attempt.listingId ||
    receipt.listingVersion !== attempt.listingVersion ||
    receipt.inputSha256 !== attempt.quotedInputSha256.toLowerCase() ||
    typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(receipt.signature)) {
    throw new Error('Marketplace terminal receipt does not match attempt');
  }
  return { version: 1, status: input.status as TerminalArchive['status'],
    archivedAt: input.archivedAt, attempt, receipt };
}

function recentAttempts(activeRecords: MarketplaceAttempt[], archivedRecords: MarketplaceAttempt[],
  quarantined: Set<string>, wallet: string, network: MarketplaceNetwork): MarketplaceAttempt[] {
  const eligible = (record: MarketplaceAttempt) =>
    !quarantined.has(quoteFileName(record.quoteId)) &&
    record.wallet.toLowerCase() === wallet && record.network === network;
  const newest = (a: MarketplaceAttempt, b: MarketplaceAttempt) =>
    b.createdAt.localeCompare(a.createdAt) || a.paymentKey.localeCompare(b.paymentKey);
  const active = activeRecords.filter(eligible).sort(newest);
  if (active.length > MAX_ATTEMPTS) throw new Error('Marketplace active attempt capacity exceeded');
  const activeByQuote = new Map(active.map(record => [quoteFileName(record.quoteId), record]));
  const terminal = archivedRecords.filter(eligible).filter(record => {
    const existing = activeByQuote.get(quoteFileName(record.quoteId));
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error('Marketplace active and archived attempt conflict');
    }
    return !existing;
  }).sort(newest);
  return [...active, ...terminal.slice(0, MAX_ATTEMPTS - active.length)];
}

/** Durable, write-once local coordinates for explicit marketplace payment recovery. */
export class FileMarketplaceAttemptStore implements MarketplaceAttemptStore {
  readonly kind = 'durable' as const;
  private readonly directory: string;
  private readonly archiveDirectory: string;
  private readonly quarantineDirectory: string;
  private stateDirectoryDurable = false;

  constructor(private readonly stateDirectory: string) {
    if (!stateDirectory) throw new Error('A marketplace attempt state directory is required');
    this.stateDirectory = resolve(stateDirectory);
    this.directory = join(this.stateDirectory, ATTEMPT_DIRECTORY);
    this.archiveDirectory = join(this.stateDirectory, ARCHIVE_DIRECTORY);
    this.quarantineDirectory = join(this.stateDirectory, QUARANTINE_DIRECTORY);
  }

  private async checkedStateDirectory(): Promise<void> {
    if (!this.stateDirectoryDurable) {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      if (!privateDirectory(await lstat(this.stateDirectory))) {
        throw new Error('Marketplace state directory must be a private directory, not a symlink');
      }
      // Existing ancestor aliases such as macOS /var -> /private/var are fine.
      // Sync the canonical parent chain so every newly created directory entry,
      // including an EEXIST race, is durable before a paid retry can proceed.
      let child = await realpath(this.stateDirectory);
      while (child !== dirname(child)) {
        await this.syncDirectory(dirname(child));
        child = dirname(child);
      }
      this.stateDirectoryDurable = true;
    }
    if (!privateDirectory(await lstat(this.stateDirectory))) {
      throw new Error('Marketplace state directory must be a private directory, not a symlink');
    }
  }

  private async checkedChildDirectory(directory: string): Promise<void> {
    await this.checkedStateDirectory();
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!privateDirectory(await lstat(directory))) {
      throw new Error('Marketplace attempt directory must be a private directory, not a symlink');
    }
    // Another process can win mkdir and still be awaiting its parent fsync.
    // Sync even when this process observed EEXIST.
    await this.syncDirectory(this.stateDirectory);
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.checkedChildDirectory(this.directory);
    const lockPath = join(this.stateDirectory, 'marketplace-attempts-v1.lock');
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!lock) throw new MarketplaceLockUnavailable('Marketplace attempt store locked; refusing payment state change');
    try { return await action(); }
    finally {
      // A failed close must not strand the lock and disable every later payment.
      try { await lock.close(); } finally { await unlink(lockPath); }
    }
  }

  private async readPrivateJson(path: string, maxBytes: number): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!privateRegularFile(stat, maxBytes)) {
        throw new Error('Marketplace state must be a bounded private regular file');
      }
      const bytes = await file.readFile();
      if (bytes.length !== stat.size || bytes.length > maxBytes) {
        throw new Error('Marketplace state changed during read');
      }
      try { return JSON.parse(decoder.decode(bytes)); }
      catch { throw new Error('Corrupt marketplace state'); }
    } finally { await file.close(); }
  }

  private async quarantineEntry(source: 'active' | 'archive', name: string): Promise<void> {
    await this.checkedChildDirectory(this.quarantineDirectory);
    const id = randomUUID();
    const metadataPath = join(this.quarantineDirectory, `${id}.meta.json`);
    const metadata = Buffer.from(JSON.stringify({ version: 1, source, originalName: name,
      quarantinedAt: new Date().toISOString() }));
    const metadataFile = await open(metadataPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await metadataFile.writeFile(metadata); await metadataFile.sync(); }
    finally { await metadataFile.close(); }
    // The metadata directory entry must survive before the data entry moves.
    await this.syncDirectory(this.quarantineDirectory);
    const sourceDirectory = source === 'active' ? this.directory : this.archiveDirectory;
    // rename moves the directory entry itself, including a symlink, without following it.
    try { await rename(join(sourceDirectory, name), join(this.quarantineDirectory, `${id}.entry`)); }
    catch (error) {
      await unlink(metadataPath);
      await this.syncDirectory(this.quarantineDirectory);
      throw error;
    }
    await this.syncDirectory(this.quarantineDirectory);
    await this.syncDirectory(sourceDirectory);
  }

  private async quarantineNamesLocked(): Promise<{ names: Set<string>; count: number }> {
    await this.checkedChildDirectory(this.quarantineDirectory);
    const entries = new Set<string>();
    const metadataIds = new Set<string>();
    const directory = await opendir(this.quarantineDirectory);
    for await (const entry of directory) {
      if (!/^[0-9a-f-]{36}\.(?:entry|meta\.json)$/.test(entry.name)) {
        throw new Error('Unexpected marketplace quarantine entry');
      }
      if (entry.name.endsWith('.entry')) entries.add(entry.name.slice(0, -'.entry'.length));
      else metadataIds.add(entry.name.slice(0, -'.meta.json'.length));
    }
    if ([...entries].some(id => !metadataIds.has(id))) {
      throw new Error('Marketplace quarantine entry lacks durable metadata');
    }
    if (metadataIds.size > MAX_ATTEMPTS) throw new Error('Marketplace quarantine capacity exceeded');
    const names = new Set<string>();
    for (const id of metadataIds) {
      const metadata = await this.readPrivateJson(join(this.quarantineDirectory, `${id}.meta.json`), 1_024);
      if (!exactFields(metadata, ['version', 'source', 'originalName', 'quarantinedAt']) ||
        metadata.version !== 1 || metadata.source !== 'active' && metadata.source !== 'archive' ||
        typeof metadata.originalName !== 'string' || metadata.originalName.includes('/') ||
        Buffer.byteLength(metadata.originalName) > 255 ||
        typeof metadata.quarantinedAt !== 'string') {
        throw new Error('Invalid marketplace quarantine metadata');
      }
      names.add(metadata.originalName);
    }
    // An orphan metadata record after power loss is still uncertain payment
    // state and occupies capacity until it is reconciled by the owner.
    return { names, count: metadataIds.size };
  }

  private async readActiveLocked(): Promise<MarketplaceAttempt[]> {
    const records: MarketplaceAttempt[] = [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error('Unexpected marketplace attempt directory entry');
      }
      try {
        if (!FILE_NAME.test(entry.name)) throw new Error('Unexpected marketplace attempt filename');
        const record = checkedRecord(await this.readPrivateJson(join(this.directory, entry.name), MAX_RECORD_BYTES));
        if (quoteFileName(record.quoteId) !== entry.name) throw new Error('Marketplace attempt filename mismatch');
        records.push(record);
      } catch {
        await this.quarantineEntry('active', entry.name);
      }
      if (records.length > MAX_ATTEMPTS) throw new Error('Marketplace attempt capacity exceeded');
    }
    return records;
  }

  private async scanLocked(): Promise<{ records: MarketplaceAttempt[]; quarantined: Set<string>; quarantineCount: number }> {
    const records = await this.readActiveLocked();
    const { names: quarantined, count: quarantineCount } = await this.quarantineNamesLocked();
    if (records.length + quarantineCount > MAX_ATTEMPTS) {
      throw new Error('Marketplace attempt capacity exceeded');
    }
    return { records, quarantined, quarantineCount };
  }

  private async finishArchiveLinkLocked(name: string): Promise<void> {
    const final = await lstat(join(this.archiveDirectory, name));
    if (final.nlink === 1) return;
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 2 ||
      final.uid !== process.getuid?.() || (final.mode & 0o077) !== 0 ||
      final.size < 1 || final.size > MAX_ARCHIVE_BYTES) {
      throw new Error('Unsafe marketplace terminal archive links');
    }
    // After a crash between link(final) and unlink(temp), remove only the
    // private temporary name of this same inode. A different hard link refuses.
    for (const entry of await readdir(this.archiveDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\.tmp-[0-9a-f-]{36}$/.test(entry.name)) continue;
      const temporary = join(this.archiveDirectory, entry.name);
      const stat = await lstat(temporary);
      if (stat.dev === final.dev && stat.ino === final.ino && stat.nlink === 2) {
        await unlink(temporary);
        await this.syncDirectory(this.archiveDirectory);
        return;
      }
    }
    throw new Error('Marketplace terminal archive has an unrecognized hard link');
  }

  private async readArchiveLocked(name: string): Promise<TerminalArchive | null> {
    await this.checkedChildDirectory(this.archiveDirectory);
    try {
      await this.finishArchiveLinkLocked(name);
      return checkedArchive(await this.readPrivateJson(join(this.archiveDirectory, name), MAX_ARCHIVE_BYTES), name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      await this.quarantineEntry('archive', name);
      throw new Error('Marketplace terminal archive quarantined; explicit recovery is required');
    }
  }

  private async allArchivesLocked(): Promise<TerminalArchive[]> {
    await this.checkedChildDirectory(this.archiveDirectory);
    const records: TerminalArchive[] = [];
    const entries = await readdir(this.archiveDirectory, { withFileTypes: true });
    for (const entry of entries) {
      // A crash before the atomic hard link can leave an unused temporary file.
      if (/^\.tmp-[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error('Unexpected marketplace archive directory entry');
      }
      if (!FILE_NAME.test(entry.name)) {
        await this.quarantineEntry('archive', entry.name);
        continue;
      }
      try {
        const archive = await this.readArchiveLocked(entry.name);
        if (archive) records.push(archive);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('quarantined')) throw error;
      }
    }
    return records;
  }

  /** Recovery remains readable after process death leaves a stale mutation lock. */
  private async readOnlySnapshot(): Promise<{ active: MarketplaceAttempt[]; archived: MarketplaceAttempt[];
    quarantined: Set<string> }> {
    await this.checkedChildDirectory(this.directory);
    await this.checkedChildDirectory(this.archiveDirectory);
    const quarantined = (await this.quarantineNamesLocked()).names;
    const active: MarketplaceAttempt[] = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !FILE_NAME.test(entry.name)) continue;
      try {
        const record = checkedRecord(await this.readPrivateJson(join(this.directory, entry.name), MAX_RECORD_BYTES));
        if (quoteFileName(record.quoteId) === entry.name) active.push(record);
      } catch { /* Never use unreadable data for payer recovery. Admission will quarantine it. */ }
    }
    const archived: MarketplaceAttempt[] = [];
    for (const entry of await readdir(this.archiveDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !FILE_NAME.test(entry.name)) continue;
      try {
        const record = checkedArchive(await this.readPrivateJson(join(this.archiveDirectory, entry.name),
          MAX_ARCHIVE_BYTES), entry.name);
        archived.push(record.attempt);
      } catch { /* An exact get will refuse unreadable evidence. */ }
    }
    return { active, archived, quarantined };
  }

  async ensureCapacity(): Promise<void> {
    await this.withLock(async () => {
      const { records, quarantineCount } = await this.scanLocked();
      if (records.length + quarantineCount >= MAX_ATTEMPTS) {
        throw new Error('Marketplace attempt limit reached before spend reservation');
      }
    });
  }

  async save(record: MarketplaceAttempt): Promise<void> {
    const checked = checkedRecord(record);
    const bytes = Buffer.from(JSON.stringify(checked), 'utf8');
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('Marketplace attempt record is too large');
    await this.withLock(async () => {
      const { records, quarantined, quarantineCount } = await this.scanLocked();
      const name = quoteFileName(checked.quoteId);
      if (quarantined.has(name)) throw new Error('Marketplace quote is quarantined; refusing payment retry');
      if (records.length + quarantineCount >= MAX_ATTEMPTS) throw new Error('Marketplace attempt limit reached');
      if (await this.readArchiveLocked(name)) throw new Error('Marketplace attempt already archived');
      const path = join(this.directory, name);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await this.syncDirectory(this.directory);
    });
  }

  async list(wallet: `0x${string}`, network: MarketplaceNetwork): Promise<MarketplaceAttempt[]> {
    const selectedWallet = checkedWallet(wallet).toLowerCase();
    const selectedNetwork = checkedNetwork(network);
    try {
      return await this.withLock(async () => {
        const { records, quarantined } = await this.scanLocked();
        const archived = await this.allArchivesLocked();
        return recentAttempts(records, archived.map(item => item.attempt), quarantined,
          selectedWallet, selectedNetwork);
      });
    } catch (error) {
      if (!(error instanceof MarketplaceLockUnavailable)) throw error;
      const snapshot = await this.readOnlySnapshot();
      return recentAttempts(snapshot.active, snapshot.archived, snapshot.quarantined,
        selectedWallet, selectedNetwork);
    }
  }

  async get(quoteId: `0x${string}`, wallet: `0x${string}`, network: MarketplaceNetwork): Promise<MarketplaceAttempt | null> {
    const name = quoteFileName(quoteId);
    const selectedWallet = checkedWallet(wallet).toLowerCase();
    const selectedNetwork = checkedNetwork(network);
    try {
      return await this.withLock(async () => {
        const { records, quarantined } = await this.scanLocked();
        if (quarantined.has(name)) throw new Error('Marketplace attempt quarantined; manual recovery required');
        const active = records.find(item => quoteFileName(item.quoteId) === name);
        const archived = active ? null : await this.readArchiveLocked(name);
        const record = active ?? archived?.attempt;
        return record && record.wallet.toLowerCase() === selectedWallet && record.network === selectedNetwork
          ? record : null;
      });
    } catch (error) {
      if (!(error instanceof MarketplaceLockUnavailable)) throw error;
      const snapshot = await this.readOnlySnapshot();
      if (snapshot.quarantined.has(name)) throw new Error('Marketplace attempt quarantined; manual recovery required');
      const record = snapshot.active.find(item => quoteFileName(item.quoteId) === name) ??
        snapshot.archived.find(item => quoteFileName(item.quoteId) === name);
      if (!record) {
        // A named but unreadable file is uncertain payment state, not absence.
        for (const directory of [this.directory, this.archiveDirectory]) {
          try { await lstat(join(directory, name)); }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') continue; throw missing; }
          throw new Error('Marketplace attempt unreadable; manual recovery required');
        }
      }
      return record && record.wallet.toLowerCase() === selectedWallet && record.network === selectedNetwork
        ? record : null;
    }
  }

  async markTerminal(quoteId: `0x${string}`, status: 'delivered' | 'refund_owed',
    receipt: VerifiedMarketplaceReceipt): Promise<void> {
    const name = quoteFileName(quoteId);
    if (!TERMINAL_STATUSES.includes(status)) throw new Error('Invalid Marketplace terminal status');
    await this.withLock(async () => {
      const { records, quarantined } = await this.scanLocked();
      if (quarantined.has(name)) throw new Error('Marketplace attempt quarantined; refusing archive');
      const active = records.find(item => quoteFileName(item.quoteId) === name);
      const prior = await this.readArchiveLocked(name);
      const attempt = active ?? prior?.attempt;
      if (!attempt) throw new Error('Marketplace attempt not found for terminal archive');
      const archive = checkedArchive({ version: 1, status, archivedAt: new Date().toISOString(),
        attempt, receipt }, name);
      if (prior) {
        if (prior.status !== status || JSON.stringify(prior.attempt) !== JSON.stringify(attempt) ||
          JSON.stringify(prior.receipt) !== JSON.stringify(receipt)) {
          throw new Error('Marketplace terminal archive conflicts with verified outcome');
        }
      } else {
        await this.checkedChildDirectory(this.archiveDirectory);
        const temporary = join(this.archiveDirectory, `.tmp-${randomUUID()}`);
        const bytes = Buffer.from(JSON.stringify(archive), 'utf8');
        if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Marketplace terminal archive is too large');
        const file = await open(temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
        try { await link(temporary, join(this.archiveDirectory, name)); }
        finally { await unlink(temporary); }
        await this.syncDirectory(this.archiveDirectory);
      }
      if (active) {
        await unlink(join(this.directory, name));
        await this.syncDirectory(this.directory);
      }
    });
  }
}

/** In-memory source-test seam. It does not provide payment recovery after a restart. */
export class MemoryMarketplaceAttemptStore implements MarketplaceAttemptStore {
  readonly kind = 'test-memory' as const;
  private readonly records = new Map<string, MarketplaceAttempt>();
  private readonly archives = new Map<string, TerminalArchive>();

  async ensureCapacity(): Promise<void> {
    if (this.records.size >= MAX_ATTEMPTS) throw new Error('Marketplace attempt limit reached before spend reservation');
  }

  async save(record: MarketplaceAttempt): Promise<void> {
    const checked = checkedRecord(record);
    const key = checked.quoteId.toLowerCase();
    if (this.records.has(key) || this.archives.has(key)) throw new Error('Marketplace attempt already exists');
    if (this.records.size >= MAX_ATTEMPTS) throw new Error('Marketplace attempt limit reached');
    if (Buffer.byteLength(JSON.stringify(checked), 'utf8') > MAX_RECORD_BYTES) {
      throw new Error('Marketplace attempt record is too large');
    }
    this.records.set(key, checked);
  }

  async list(wallet: `0x${string}`, network: MarketplaceNetwork): Promise<MarketplaceAttempt[]> {
    const selectedWallet = checkedWallet(wallet).toLowerCase();
    const selectedNetwork = checkedNetwork(network);
    return recentAttempts([...this.records.values()], [...this.archives.values()].map(item => item.attempt),
      new Set(), selectedWallet, selectedNetwork)
      .map(record => ({ ...record }));
  }

  async get(quoteId: `0x${string}`, wallet: `0x${string}`, network: MarketplaceNetwork): Promise<MarketplaceAttempt | null> {
    const key = quoteFileName(quoteId).slice(0, -'.json'.length);
    const selectedWallet = checkedWallet(wallet).toLowerCase();
    const selectedNetwork = checkedNetwork(network);
    const record = this.records.get(key) ?? this.archives.get(key)?.attempt;
    return record && record.wallet.toLowerCase() === selectedWallet && record.network === selectedNetwork
      ? { ...record } : null;
  }

  async markTerminal(quoteId: `0x${string}`, status: 'delivered' | 'refund_owed',
    receipt: VerifiedMarketplaceReceipt): Promise<void> {
    const key = quoteFileName(quoteId).slice(0, -'.json'.length);
    const attempt = this.records.get(key) ?? this.archives.get(key)?.attempt;
    if (!attempt) throw new Error('Marketplace attempt not found for terminal archive');
    const archive = checkedArchive({ version: 1, status, archivedAt: new Date().toISOString(),
      attempt, receipt }, `${key}.json`);
    const prior = this.archives.get(key);
    if (prior && (prior.status !== status || JSON.stringify(prior.receipt) !== JSON.stringify(receipt))) {
      throw new Error('Marketplace terminal archive conflicts with verified outcome');
    }
    if (!prior) this.archives.set(key, archive);
    this.records.delete(key);
  }
}
