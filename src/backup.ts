import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { privateKeyToAccount } from 'viem/accounts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const BACKUP_NAMESPACE_PATH = '/v1/agent/memory/agent-wallet';
const BACKUP_VALUE_TYPE = 'client-encrypted:agent-wallet-v1';
const RECOVERY_SECRET_PREFIX = 'voidly-rs-v1-';

/** A CSPRNG-backed, 32-byte secret for a new encrypted wallet backup. */
export function generateRecoverySecret(): string {
  return `${RECOVERY_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function isGeneratedRecoverySecret(secret: string): boolean {
  if (!secret.startsWith(RECOVERY_SECRET_PREFIX)) return false;
  const encoded = secret.slice(RECOVERY_SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === encoded;
}

export interface EncryptedWalletBackup {
  version: 1;
  kdf: 'scrypt-n32768-r8-p1';
  salt: string;
  nonce: string;
  ciphertext: string;
}

function decodeBase64(value: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Malformed encrypted backup');
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (expectedLength !== undefined && bytes.length !== expectedLength) throw new Error('Malformed encrypted backup');
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function backupKey(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  if (encoder.encode(secret).length < 16) throw new Error('Recovery secret must contain at least 16 bytes');
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(new Uint8Array(key));
    });
  });
}

/** The private key is encrypted locally before this envelope can reach Relay. */
export async function encryptWalletBackup(privateKey: `0x${string}`, secret: string): Promise<EncryptedWalletBackup> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid private key');
  if (!isGeneratedRecoverySecret(secret)) {
    throw new Error('New wallet backups require a generated 32-byte recovery secret');
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(nacl.secretbox.nonceLength);
  const key = await backupKey(secret, salt);
  const plaintext = encoder.encode(JSON.stringify({
    version: 1,
    address: privateKeyToAccount(privateKey).address,
    privateKey,
  }));
  try {
    const ciphertext = nacl.secretbox(plaintext, nonce, key);
    return {
      version: 1,
      kdf: 'scrypt-n32768-r8-p1',
      salt: encodeBase64(salt),
      nonce: encodeBase64(nonce),
      ciphertext: encodeBase64(ciphertext),
    };
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

export async function decryptWalletBackup(envelope: EncryptedWalletBackup, secret: string): Promise<`0x${string}`> {
  if (!envelope || envelope.version !== 1 || envelope.kdf !== 'scrypt-n32768-r8-p1') {
    throw new Error('Unsupported encrypted backup');
  }
  const salt = decodeBase64(envelope.salt, 16);
  const nonce = decodeBase64(envelope.nonce, nacl.secretbox.nonceLength);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (ciphertext.length < nacl.secretbox.overheadLength || ciphertext.length > 4096) {
    throw new Error('Malformed encrypted backup');
  }
  const key = await backupKey(secret, salt);
  try {
    const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
    if (!plaintext) throw new Error('Wrong recovery secret or damaged backup');
    try {
      const parsed: unknown = JSON.parse(decoder.decode(plaintext));
      if (!parsed || typeof parsed !== 'object') throw new Error('Malformed encrypted backup');
      const record = parsed as Record<string, unknown>;
      if (record.version !== 1 || typeof record.privateKey !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(record.privateKey) || typeof record.address !== 'string') {
        throw new Error('Malformed encrypted backup');
      }
      const privateKey = record.privateKey as `0x${string}`;
      if (privateKeyToAccount(privateKey).address.toLowerCase() !== record.address.toLowerCase()) {
        throw new Error('Backup address does not match key');
      }
      return privateKey;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export interface WalletBackupStore {
  put(envelope: EncryptedWalletBackup): Promise<void>;
  get(): Promise<EncryptedWalletBackup | null>;
}

/** A local encrypted vault. The recovery secret must be held outside this file. */
export class LocalWalletBackupStore implements WalletBackupStore {
  private readonly path: string;

  constructor(private readonly stateDirectory: string) {
    if (!stateDirectory) throw new Error('A local vault directory is required');
    this.path = join(stateDirectory, 'wallet-backup-v1.json');
  }

  private async privateDirectory(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.stateDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
      throw new Error('Wallet vault directory must be private and not a symlink');
    }
  }

  async put(envelope: EncryptedWalletBackup): Promise<void> {
    await this.privateDirectory();
    const temporary = `${this.path}.${randomBytes(12).toString('hex')}.tmp`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(envelope));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // link creates the final name only if it does not already exist.
      await link(temporary, this.path);
      const directory = await open(this.stateDirectory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temporary);
    }
  }

  async get(): Promise<EncryptedWalletBackup | null> {
    await this.privateDirectory();
    try {
      const file = await lstat(this.path);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.size > 8192) {
        throw new Error('Wallet vault must be a private regular file');
      }
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('Malformed local wallet vault');
      return parsed as EncryptedWalletBackup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/** Relay receives an encrypted wallet-key envelope linked to the wallet address and authenticated agent; no plaintext key or recovery secret. */
export class RelayWalletBackupStore implements WalletBackupStore {
  private readonly url: string;

  private static origin(baseUrl: string, agentApiKey: string): URL {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('Relay base URL must be an HTTPS origin');
    }
    if (!agentApiKey) throw new Error('Relay agent API key is required');
    return base;
  }

  readonly backupKey: string;

  constructor(baseUrl: string, private readonly agentApiKey: string,
    readonly walletAddress: `0x${string}`, private readonly fetcher: typeof fetch = fetch,
    backupKey?: string) {
    const base = RelayWalletBackupStore.origin(baseUrl, agentApiKey);
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) throw new Error('Invalid wallet backup address');
    this.backupKey = backupKey ?? `${walletAddress.toLowerCase()}.${randomBytes(16).toString('hex')}`;
    if (RelayWalletBackupStore.addressFromBackupKey(this.backupKey) !== walletAddress.toLowerCase()) {
      throw new Error('Relay backup key does not match wallet address');
    }
    this.url = new URL(`${BACKUP_NAMESPACE_PATH}/${this.backupKey}`, base).href;
  }

  static addressFromBackupKey(key: string): `0x${string}` | null {
    const match = /^(0x[0-9a-f]{40})\.[0-9a-f]{32}$/.exec(key);
    return match ? match[1] as `0x${string}` : null;
  }

  /** List address-prefixed backups without reading ciphertext. A fixed primary slot is never used. */
  static async listBackupKeys(baseUrl: string, agentApiKey: string, fetcher: typeof fetch = fetch): Promise<string[]> {
    const base = RelayWalletBackupStore.origin(baseUrl, agentApiKey);
    const keys: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = new URL(BACKUP_NAMESPACE_PATH, base);
      url.searchParams.set('limit', '500');
      if (after) url.searchParams.set('after', after);
      const response = await fetcher(url.href, {
        headers: { 'X-Agent-Key': agentApiKey }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Relay backup list failed (${response.status})`);
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Malformed Relay backup list');
      const record = data as Record<string, unknown>;
      if (!Array.isArray(record.keys) || record.keys.length > 500) throw new Error('Malformed Relay backup list');
      for (const row of record.keys) {
        if (!row || typeof row !== 'object' || typeof (row as { key?: unknown }).key !== 'string') {
          throw new Error('Malformed Relay backup list');
        }
        keys.push((row as { key: string }).key);
      }
      if (record.has_more === false) return keys;
      if (record.has_more !== true || typeof record.next_cursor !== 'string' ||
        !record.next_cursor || record.next_cursor === after) throw new Error('Malformed Relay backup cursor');
      after = record.next_cursor;
    }
    throw new Error('Relay backup list exceeds supported page limit');
  }

  static async listWalletAddresses(baseUrl: string, agentApiKey: string, fetcher: typeof fetch = fetch): Promise<`0x${string}`[]> {
    const keys = await RelayWalletBackupStore.listBackupKeys(baseUrl, agentApiKey, fetcher);
    return [...new Set(keys.map(key => RelayWalletBackupStore.addressFromBackupKey(key)).filter((value): value is `0x${string}` => value !== null))];
  }

  async put(envelope: EncryptedWalletBackup): Promise<void> {
    // Random backup keys prevent ordinary same-wallet collisions. Relay PUT has
    // no CAS, so a caller reusing a known key can still race this preflight.
    if (await this.get()) throw new Error('Relay wallet backup already exists for this key');
    const response = await this.fetcher(this.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Agent-Key': this.agentApiKey },
      body: JSON.stringify({ value: JSON.stringify(envelope), value_type: BACKUP_VALUE_TYPE }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Relay backup write failed (${response.status})`);
  }

  async get(): Promise<EncryptedWalletBackup | null> {
    const response = await this.fetcher(this.url, {
      headers: { 'X-Agent-Key': this.agentApiKey },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Relay backup read failed (${response.status})`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('value' in data)) throw new Error('Malformed Relay backup response');
    if ((data as { value_type?: unknown }).value_type !== BACKUP_VALUE_TYPE) {
      throw new Error('Unexpected Relay wallet backup type');
    }
    const value = (data as { value: unknown }).value;
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Malformed Relay backup response');
    const envelope: unknown = JSON.parse(value);
    if (!envelope || typeof envelope !== 'object') throw new Error('Malformed Relay backup response');
    return envelope as EncryptedWalletBackup;
  }
}
