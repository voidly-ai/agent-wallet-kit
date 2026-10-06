import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FileMarketplaceAttemptStore,
  MemoryMarketplaceAttemptStore,
  type MarketplaceAttempt,
} from '../src/marketplaceRecovery.js';
import type { VerifiedMarketplaceReceipt } from '../src/marketplaceReceiptVerification.js';

const wallet = `0x${'1'.repeat(40)}` as `0x${string}`;
const otherWallet = `0x${'2'.repeat(40)}` as `0x${string}`;
const hex32 = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

function attempt(paymentKey = hex32('b')): MarketplaceAttempt {
  return {
    version: 1,
    quoteId: hex32('a'),
    paymentKey,
    wallet,
    payTo: otherWallet,
    asset: `0x${'3'.repeat(40)}`,
    network: 'eip155:84532',
    listingId: 'synthetic-listing',
    listingVersion: 2,
    targetUrl: 'https://x402.voidly.ai/v1/services/synthetic-listing/call',
    quoteUrl: `https://x402.voidly.ai/v1/services/synthetic-listing/call?quote=${hex32('a')}`,
    amountAtomic: '25000',
    requestBodySha256: hex32('c'),
    quotedInputSha256: hex32('d'),
    createdAt: '2026-10-05T00:00:00.000Z',
  };
}

function receipt(record: MarketplaceAttempt, status: 'delivered' | 'refund_owed'): VerifiedMarketplaceReceipt {
  return {
    version: 'voidpay-x402-delivery-v1', keyVersion: 1, network: record.network,
    asset: record.asset, transactionHash: hex32('e'), payerWallet: record.wallet,
    payTo: record.payTo, amountAtomic: record.amountAtomic, resourceUrl: record.quoteUrl,
    context: null, blockNumber: '1', confirmationsAtDelivery: 12,
    listingId: record.listingId, listingVersion: record.listingVersion,
    inputSha256: record.quotedInputSha256, outputSha256: status === 'delivered' ? hex32('f') : null,
    deliveredAt: status === 'delivered' ? 1_000 : null, status,
    quoteId: record.quoteId, quoteExpiresAt: 2_000, paymentKey: record.paymentKey,
    outputSchemaMatched: status === 'delivered' ? true : null,
    failureCode: status === 'refund_owed' ? 'seller_delivery_failed' : null,
    outcomeAt: 1_000, signature: 'A'.repeat(86),
  };
}

test('file attempts survive restart exactly and stay scoped to wallet and network', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const record = attempt();
    const first = new FileMarketplaceAttemptStore(state);
    await first.ensureCapacity();
    await first.save(record);
    const second = new FileMarketplaceAttemptStore(state);
    assert.equal(second.kind, 'durable');
    assert.deepEqual(await second.list(wallet, 'eip155:84532'), [record]);
    assert.deepEqual(await second.get(record.quoteId, wallet, 'eip155:84532'), record);
    assert.equal(await second.get(record.quoteId, otherWallet, 'eip155:84532'), null);
    assert.deepEqual(await second.list(otherWallet, 'eip155:84532'), []);
    assert.deepEqual(await second.list(wallet, 'eip155:8453'), []);

    const files = await readdir(join(state, 'marketplace-attempts-v1'));
    assert.deepEqual(files, [`${record.quoteId}.json`]);
    const path = join(state, 'marketplace-attempts-v1', files[0]!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('duplicate quote IDs fail even when concurrent or with a different payment key', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const store = new FileMarketplaceAttemptStore(state);
    const record = attempt();
    const attempts = await Promise.allSettled([store.save(record), store.save(record)]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
    await assert.rejects(store.save({ ...record, paymentKey: hex32('e') }), { code: 'EEXIST' });
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [record]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('concurrent distinct quotes cannot exceed capacity and disable recovery', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const first = new FileMarketplaceAttemptStore(state);
    const record = attempt();
    await first.save(record);
    const directory = join(state, 'marketplace-attempts-v1');
    for (let start = 0; start < 998; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 998 - start) }, (_, offset) => {
        const quoteId = `0x${(start + offset).toString(16).padStart(64, '0')}` as `0x${string}`;
        const record = { ...attempt(), quoteId,
          quoteUrl: `https://x402.voidly.ai/v1/services/synthetic-listing/call?quote=${quoteId}` };
        return writeFile(join(directory, `${quoteId}.json`), JSON.stringify(record), { mode: 0o600 });
      }));
    }
    const second = new FileMarketplaceAttemptStore(state);
    const next = (digit: string): MarketplaceAttempt => {
      const quoteId = hex32(digit);
      return { ...attempt(), quoteId,
        quoteUrl: `https://x402.voidly.ai/v1/services/synthetic-listing/call?quote=${quoteId}` };
    };
    const results = await Promise.allSettled([first.save(next('e')), second.save(next('f'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await first.list(wallet, 'eip155:84532')).length, 1_000,
      'all original recovery records remain readable at capacity');
    await assert.rejects(first.ensureCapacity(), /before spend reservation/);
    await first.markTerminal(record.quoteId, 'refund_owed', receipt(record, 'refund_owed'));
    await second.ensureCapacity();
    assert.deepEqual(await second.get(record.quoteId, wallet, 'eip155:84532'), record,
      'archiving frees admission capacity without losing payer recovery');
    await second.save(next('c'));
    await assert.rejects(first.ensureCapacity(), /before spend reservation/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('corrupt, symlinked, and public attempt files are quarantined without hiding valid attempts', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const store = new FileMarketplaceAttemptStore(state);
    const record = attempt();
    await store.save(record);
    const path = join(state, 'marketplace-attempts-v1', `${record.quoteId}.json`);
    await writeFile(path, '{');
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), []);
    await assert.rejects(store.get(record.quoteId, wallet, 'eip155:84532'), /quarantined/);
    await assert.rejects(store.save(record), /quarantined/);
    await store.ensureCapacity();
    const validQuoteId = hex32('f');
    const valid = { ...attempt(hex32('e')), quoteId: validQuoteId,
      quoteUrl: `https://x402.voidly.ai/v1/services/synthetic-listing/call?quote=${validQuoteId}` };
    await store.save(valid);
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [valid]);
    const quarantine = join(state, 'marketplace-attempts-v1-quarantine');
    const entries = await readdir(quarantine);
    assert.equal(entries.filter(name => name.endsWith('.entry')).length, 1);
    const metadata = JSON.parse(await readFile(join(quarantine,
      entries.find(name => name.endsWith('.meta.json'))!), 'utf8'));
    assert.equal(metadata.originalName, `${record.quoteId}.json`);

    const outside = join(state, 'outside.json');
    await writeFile(outside, JSON.stringify(record), { mode: 0o600 });
    await symlink(outside, path);
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [valid]);
    assert.equal(await readFile(outside, 'utf8'), JSON.stringify(record),
      'quarantining a symlink must not follow or alter its target');

    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    await writeFile(path, JSON.stringify({ ...record,
      quoteUrl: `https://x402.voidly.ai/v1/services/synthetic-listing/call?quote=${hex32('e')}` }));
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [valid]);

    await writeFile(path, 'x'.repeat(8_193));
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [valid]);

    await writeFile(path, JSON.stringify(record));
    await chmod(path, 0o644);
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [valid]);
    assert.equal((await readdir(quarantine)).filter(name => name.endsWith('.entry')).length, 5);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('verified terminal archive retains signed refund evidence and exact-quote recovery after restart', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const record = attempt();
    const signed = receipt(record, 'refund_owed');
    const first = new FileMarketplaceAttemptStore(state);
    await first.save(record);
    await assert.rejects(first.markTerminal(record.quoteId, 'delivered', signed), /does not match attempt/);
    assert.deepEqual(await first.get(record.quoteId, wallet, 'eip155:84532'), record);
    await first.markTerminal(record.quoteId, 'refund_owed', signed);
    await first.markTerminal(record.quoteId, 'refund_owed', signed);
    const second = new FileMarketplaceAttemptStore(state);
    assert.deepEqual(await second.get(record.quoteId, wallet, 'eip155:84532'), record);
    assert.deepEqual(await second.list(wallet, 'eip155:84532'), [record]);
    await second.ensureCapacity();
    const archive = JSON.parse(await readFile(join(state, 'marketplace-attempts-v1-archive',
      `${record.quoteId}.json`), 'utf8'));
    assert.equal(archive.status, 'refund_owed');
    assert.deepEqual(archive.attempt, record);
    assert.deepEqual(archive.receipt, signed);
    const archivedPath = join(state, 'marketplace-attempts-v1-archive', `${record.quoteId}.json`);
    const interruptedTemp = join(state, 'marketplace-attempts-v1-archive',
      '.tmp-00000000-0000-4000-8000-000000000000');
    await link(archivedPath, interruptedTemp);
    assert.equal((await stat(archivedPath)).nlink, 2);
    assert.deepEqual(await second.get(record.quoteId, wallet, 'eip155:84532'), record,
      'restart repairs only its own still-linked archive temporary file');
    assert.equal((await stat(archivedPath)).nlink, 1);
    await assert.rejects(stat(interruptedTemp), { code: 'ENOENT' });
    await writeFile(join(state, 'marketplace-attempts-v1', `${record.quoteId}.json`),
      JSON.stringify(record), { mode: 0o600 });
    assert.deepEqual(await second.list(wallet, 'eip155:84532'), [record],
      'an interrupted active unlink must not show a duplicate quote');
    await second.markTerminal(record.quoteId, 'refund_owed', signed);
    assert.deepEqual(await readdir(join(state, 'marketplace-attempts-v1')), []);
    await assert.rejects(second.save(record), /already archived/);
    await assert.rejects(second.markTerminal(record.quoteId, 'delivered', receipt(record, 'delivered')),
      /conflicts with verified outcome/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('read-only discovery and exact recovery remain available after a process leaves the mutation lock', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const record = attempt();
    const store = new FileMarketplaceAttemptStore(state);
    await store.save(record);
    await writeFile(join(state, 'marketplace-attempts-v1.lock'), '', { mode: 0o600 });
    const recovered = new FileMarketplaceAttemptStore(state);
    assert.deepEqual(await recovered.list(wallet, 'eip155:84532'), [record]);
    assert.deepEqual(await recovered.get(record.quoteId, wallet, 'eip155:84532'), record);
    await assert.rejects(recovered.ensureCapacity(), /store locked/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('orphan quarantine metadata after interruption still blocks only its uncertain quote', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  try {
    const quarantine = join(state, 'marketplace-attempts-v1-quarantine');
    await mkdir(quarantine, { mode: 0o700 });
    await writeFile(join(quarantine, '00000000-0000-4000-8000-000000000000.meta.json'),
      JSON.stringify({ version: 1, source: 'active', originalName: `${attempt().quoteId}.json`,
        quarantinedAt: new Date().toISOString() }), { mode: 0o600 });
    const store = new FileMarketplaceAttemptStore(state);
    await store.ensureCapacity();
    await assert.rejects(store.save(attempt()), /quarantined/);
    await assert.rejects(store.get(attempt().quoteId, wallet, 'eip155:84532'), /quarantined/);
    const quoteId = hex32('f');
    const unrelated = { ...attempt(), quoteId, quoteUrl: `${attempt().targetUrl}?quote=${quoteId}` };
    await store.save(unrelated);
    assert.deepEqual(await store.list(wallet, 'eip155:84532'), [unrelated]);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('recent archived attempts stay discoverable while exact get reaches older archive entries', async () => {
  const memory = new MemoryMarketplaceAttemptStore();
  const oldest = attempt();
  await memory.save(oldest);
  for (let index = 0; index < 1_001; index++) {
    const quoteId = `0x${(index + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
    const record: MarketplaceAttempt = { ...oldest, quoteId,
      quoteUrl: `${oldest.targetUrl}?quote=${quoteId}`,
      createdAt: new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString() };
    await memory.ensureCapacity();
    await memory.save(record);
    await memory.markTerminal(quoteId, 'delivered', receipt(record, 'delivered'));
  }
  const visible = await memory.list(wallet, 'eip155:84532');
  assert.equal(visible.length, 1_000);
  assert.equal(visible[0]?.quoteId, oldest.quoteId,
    'an older active payment must remain discoverable ahead of newer terminal archives');
  const firstQuoteId = `0x${'1'.padStart(64, '0')}` as `0x${string}`;
  assert.equal(visible.some(item => item.quoteId === firstQuoteId), false);
  assert.equal((await memory.get(firstQuoteId, wallet, 'eip155:84532'))?.quoteId, firstQuoteId);
});

test('symlinked state directory and extra secret fields are refused', async () => {
  const state = await mkdtemp(join(tmpdir(), 'voidly-marketplace-attempt-'));
  const link = `${state}-link`;
  try {
    await symlink(state, link);
    await assert.rejects(new FileMarketplaceAttemptStore(link).save(attempt()), /private directory/);
    const memory = new MemoryMarketplaceAttemptStore();
    assert.equal(memory.kind, 'test-memory');
    await assert.rejects(memory.save({ ...attempt(), privateKey: hex32('f') } as MarketplaceAttempt),
      /Invalid marketplace attempt record/);
    await memory.save(attempt());
    assert.deepEqual(await memory.list(wallet, 'eip155:84532'), [attempt()]);
    await assert.rejects(memory.save(attempt()), /already exists/);
  } finally {
    await rm(link, { force: true });
    await rm(state, { recursive: true, force: true });
  }
});
