import { constants } from 'node:fs';
import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseUnits } from 'viem';

export type BaseNetwork = 'base' | 'base-sepolia';

export interface SpendLimits {
  /** Decimal USDC, with at most six fractional digits. */
  perCallUsd: string;
  /** UTC-calendar-day cap. Reservations count even if settlement later fails. */
  dailyUsd: string;
}

export function usdToAtomic(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/.test(value)) {
    throw new Error('USDC limit must be a nonnegative decimal with up to six places');
  }
  return parseUnits(value, 6);
}

export function validateSpendLimits(limits: SpendLimits): { perCall: bigint; daily: bigint } {
  const perCall = usdToAtomic(limits.perCallUsd);
  const daily = usdToAtomic(limits.dailyUsd);
  if (perCall <= 0n || daily <= 0n || perCall > daily) {
    throw new Error('Spend limits must be positive and per-call must not exceed daily');
  }
  return { perCall, daily };
}

export interface SpendReservation {
  wallet: `0x${string}`;
  network: BaseNetwork;
  amountAtomic: bigint;
  dailyLimitAtomic: bigint;
  now?: Date;
}

export interface SpendStore {
  /** A custom durable store must atomically commit a reservation before returning. */
  readonly kind: 'durable' | 'test-memory';
  /** Must reserve durably before returning. Never refund an authorization automatically. */
  reserve(request: SpendReservation): Promise<{ day: string; reservedAtomic: bigint }>;
}

interface StoredDay {
  version: 1;
  day: string;
  reservedAtomic: string;
  /** A restored wallet on a new host waits until the next UTC day. */
  blockedUntil?: string;
}

function dayOf(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid clock');
  return date.toISOString().slice(0, 10);
}

/** A durable, fail-closed local budget for one wallet and one Base network. */
export class FileSpendStore implements SpendStore {
  readonly kind = 'durable' as const;
  constructor(private readonly stateDirectory: string) {
    if (!stateDirectory) throw new Error('A spend state directory is required');
  }

  private async privateDirectory(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.stateDirectory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) {
      throw new Error('Spend state directory must be private and must not be a symlink');
    }
  }

  private pathFor(wallet: `0x${string}`, network: BaseNetwork): string {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid wallet address');
    if (network !== 'base' && network !== 'base-sepolia') throw new Error('Unsupported network');
    return join(this.stateDirectory, `${wallet.toLowerCase()}-${network}.json`);
  }

  /** Create a ledger once. A restored wallet with no prior local ledger waits until the next UTC day. */
  async initialize(wallet: `0x${string}`, network: BaseNetwork, recovered = false, now = new Date()): Promise<void> {
    const day = dayOf(now);
    await this.privateDirectory();
    const path = this.pathFor(wallet, network);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    try {
      const record: StoredDay = { version: 1, day, reservedAtomic: '0' };
      if (recovered) record.blockedUntil = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async reserve(request: SpendReservation): Promise<{ day: string; reservedAtomic: bigint }> {
    if (request.amountAtomic <= 0n || request.dailyLimitAtomic <= 0n) throw new Error('Invalid amount');
    const day = dayOf(request.now ?? new Date());

    await this.privateDirectory();
    const path = this.pathFor(request.wallet, request.network);
    const lockPath = `${path}.lock`;
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
    if (!lock) throw new Error('Spend ledger locked; refusing to authorize payment');

    try {
      let current: StoredDay;
      try {
        const file = await lstat(path);
        if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
          throw new Error('Spend ledger must be a private regular file');
        }
        current = JSON.parse(await readFile(path, 'utf8')) as StoredDay;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('Spend ledger missing; refusing to authorize payment');
        }
        throw error;
      }
      if (current.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(current.day) ||
        !/^(?:0|[1-9]\d*)$/.test(current.reservedAtomic) ||
        (current.blockedUntil !== undefined && (!Number.isFinite(Date.parse(current.blockedUntil)) ||
          new Date(current.blockedUntil).toISOString() !== current.blockedUntil))) {
        throw new Error('Invalid spend ledger; refusing to authorize payment');
      }
      if (current.day > day) throw new Error('Clock moved backward; refusing to authorize payment');
      if (current.blockedUntil && (request.now ?? new Date()).getTime() < Date.parse(current.blockedUntil)) {
        throw new Error('Recovered wallet is paused until the next UTC day');
      }
      const already = current.day === day ? BigInt(current.reservedAtomic) : 0n;
      const next = already + request.amountAtomic;
      if (next > request.dailyLimitAtomic) throw new Error('Daily USDC authorization limit exceeded');

      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const out = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await out.writeFile(JSON.stringify({ version: 1, day, reservedAtomic: next.toString(),
            ...(current.blockedUntil ? { blockedUntil: current.blockedUntil } : {}) } satisfies StoredDay));
          await out.sync();
        } finally {
          await out.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(this.stateDirectory, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } finally {
        await unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      return { day, reservedAtomic: next };
    } finally {
      try { await lock.close(); } finally { await unlink(lockPath); }
    }
  }
}

/** Useful for source-only tests. This is not a durable production spend ledger. */
export class MemorySpendStore implements SpendStore {
  readonly kind = 'test-memory' as const;
  private readonly days = new Map<string, StoredDay>();

  async reserve(request: SpendReservation): Promise<{ day: string; reservedAtomic: bigint }> {
    const day = dayOf(request.now ?? new Date());
    const key = `${request.wallet.toLowerCase()}:${request.network}`;
    const current = this.days.get(key);
    if (current && current.day > day) throw new Error('Clock moved backward');
    const previous = current?.day === day ? BigInt(current.reservedAtomic) : 0n;
    const next = previous + request.amountAtomic;
    if (next > request.dailyLimitAtomic) throw new Error('Daily USDC authorization limit exceeded');
    this.days.set(key, { version: 1, day, reservedAtomic: next.toString() });
    return { day, reservedAtomic: next };
  }
}
