#!/usr/bin/env node
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentWallet, PaymentMayHaveSettledError, RelayWalletBackupStore, LocalWalletBackupStore, FileSpendStore, FileMarketplaceAttemptStore, generateRecoverySecret, isGeneratedRecoverySecret, type AgentWalletOptions, type BaseNetwork, type WalletBackupStore } from './index.js';

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (error: unknown) => ({
  content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Wallet operation failed' }],
  isError: true,
});

function stateDirectory(): string {
  return process.env.VOIDLY_WALLET_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'voidly-agent-wallet');
}

function environmentOptions(): AgentWalletOptions {
  const network = process.env.VOIDLY_WALLET_NETWORK ?? 'base-sepolia';
  if (network !== 'base' && network !== 'base-sepolia') throw new Error('VOIDLY_WALLET_NETWORK must be base or base-sepolia');
  const allowedOrigins = process.env.VOIDLY_WALLET_ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean);
  if (network === 'base' && !allowedOrigins?.length) {
    throw new Error('Base mainnet requires VOIDLY_WALLET_ALLOWED_ORIGINS before the MCP server starts');
  }
  return {
    network: network as BaseNetwork,
    limits: {
      perCallUsd: process.env.VOIDLY_WALLET_PER_CALL_USDC ?? '1',
      dailyUsd: process.env.VOIDLY_WALLET_DAILY_USDC ?? '5',
    },
    spendStore: process.env.VOIDLY_WALLET_MEMORY_ONLY === '1' ? undefined : new FileSpendStore(stateDirectory()),
    marketplaceAttemptStore: process.env.VOIDLY_WALLET_MEMORY_ONLY === '1' ? undefined : new FileMarketplaceAttemptStore(stateDirectory()),
    rpcUrl: process.env.VOIDLY_WALLET_RPC_URL || undefined,
    allowedOrigins,
  };
}

function boundedHeader(headers: Headers, name: string, errors: string[]): string | null {
  try {
    const value = headers.get(name);
    if (value === null) return null;
    if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push(`${name} is malformed`);
      return null;
    }
    if (Buffer.byteLength(value, 'utf8') > 16_384) {
      errors.push(`${name} exceeds 16,384 bytes`);
      return null;
    }
    return value;
  } catch {
    errors.push(`${name} could not be read`);
    return null;
  }
}

async function boundedResponse(response: Response, deadlineMs = 15_000): Promise<{
  status: number; contentType: string | null; paymentResponse: string | null; deliveryReceipt: string | null;
  headerErrors: string[]; body: string | null; bodyBase64: string; bodyEncoding: 'base64';
  bodyBytes: number; truncated: boolean; bodyReadError: boolean; recoveryHint: string | null;
}> {
  const status = response.status;
  const headerErrors: string[] = [];
  const contentType = boundedHeader(response.headers, 'content-type', headerErrors);
  const paymentResponse = boundedHeader(response.headers, 'payment-response', headerErrors);
  const deliveryReceipt = boundedHeader(response.headers, 'x-voidpay-delivery-receipt', headerErrors);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  let bodyReadError = false;
  const deadline = performance.now() + deadlineMs;
  try {
    reader = response.body?.getReader();
    while (true) {
      if (!reader) break;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error('Paid response body read timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Paid response body read timed out')), remainingMs);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      const remaining = 1_000_000 - length;
      if (next.value.length > remaining) {
        if (remaining > 0) chunks.push(Uint8Array.from(next.value.subarray(0, remaining)));
        length = 1_000_000;
        truncated = true;
        break;
      }
      length += next.value.length;
      chunks.push(Uint8Array.from(next.value));
      if (length === 1_000_000) {
        truncated = true; // Stop at the cap without waiting for another network chunk.
        break;
      }
    }
  } catch {
    bodyReadError = true;
  } finally {
    // Cancellation can itself stall; the payment metadata must still return.
    void reader?.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks, length);
  let body: string | null;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { body = null; }
  return {
    status, contentType, paymentResponse, deliveryReceipt, headerErrors,
    body, bodyBase64: bytes.toString('base64'), bodyEncoding: 'base64',
    bodyBytes: length, truncated, bodyReadError,
    recoveryHint: truncated || bodyReadError || headerErrors.length > 0
      ? 'Paid response body or metadata may be incomplete. Do not repay. Preserve available headers and request context; use service recovery only if its required quote and payment identifiers were retained.'
      : null,
  };
}

export interface WalletMcpDependencies {
  /** Source-test seam. Runtime uses local cryptographic key generation. */
  createWallet?: () => AgentWallet;
  /** Source-test seam for inert signer tests; never supplied by the runtime. */
  initialWallet?: AgentWallet;
  localBackupStore?: () => WalletBackupStore;
  relayBackupStore?: (address: `0x${string}`, backupKey?: string) => WalletBackupStore;
  relayBackupKeys?: () => Promise<string[]>;
  recoverySecret?: () => string;
  memoryOnly?: boolean;
  /** Source-test seam for a hanging paid response stream. */
  responseBodyDeadlineMsForTests?: number;
}

export function createWalletMcpServer(options: AgentWalletOptions = environmentOptions(), dependencies: WalletMcpDependencies = {}): McpServer {
  if (options.network === 'base' && !options.allowedOrigins?.length) {
    throw new Error('Base mainnet requires an explicit payment origin allowlist before the MCP server starts');
  }
  const server = new McpServer({ name: 'voidly-agent-wallet', version: '0.1.1' });
  let wallet: AgentWallet | undefined = dependencies.initialWallet;
  let generatedSecret: string | undefined;
  const requireWallet = () => {
    if (!wallet) throw new Error('Create or restore a wallet first');
    return wallet;
  };
  const relayStore = dependencies.relayBackupStore ?? ((address: `0x${string}`, backupKey?: string) => {
    const agentKey = process.env.VOIDLY_AGENT_KEY;
    if (!agentKey) throw new Error('VOIDLY_AGENT_KEY is required for Relay backup');
    return new RelayWalletBackupStore(process.env.VOIDLY_RELAY_URL ?? 'https://api.voidly.ai', agentKey, address, fetch, backupKey);
  });
  const relayBackupKeys = dependencies.relayBackupKeys ?? (() => {
    const agentKey = process.env.VOIDLY_AGENT_KEY;
    if (!agentKey) throw new Error('VOIDLY_AGENT_KEY is required for Relay backup');
    return RelayWalletBackupStore.listBackupKeys(process.env.VOIDLY_RELAY_URL ?? 'https://api.voidly.ai', agentKey);
  });
  const localStore = dependencies.localBackupStore ?? (() => new LocalWalletBackupStore(stateDirectory()));
  const recoverySecret = dependencies.recoverySecret ?? (() => {
    const secret = process.env.VOIDLY_WALLET_RECOVERY_SECRET ?? generatedSecret;
    if (!secret) throw new Error('VOIDLY_WALLET_RECOVERY_SECRET is required for encrypted wallet backup');
    if (Buffer.byteLength(secret, 'utf8') < 16) throw new Error('Recovery secret must contain at least 16 bytes');
    return secret;
  });
  const newRecoverySecret = () => {
    const secret = recoverySecret();
    if (!isGeneratedRecoverySecret(secret)) {
      throw new Error('New wallet backups require a generated 32-byte recovery secret');
    }
    return secret;
  };
  const memoryOnly = dependencies.memoryOnly ?? process.env.VOIDLY_WALLET_MEMORY_ONLY === '1';

  server.registerTool('wallet_generate_recovery_secret', {
    description: 'Generate a one-time 32-byte recovery secret. Store it in the agent secret manager before creating a wallet; it is never sent to Voidly.',
    inputSchema: z.object({}),
  }, async () => {
    if (wallet || generatedSecret || process.env.VOIDLY_WALLET_RECOVERY_SECRET) {
      return fail(new Error('A wallet or recovery secret is already configured; do not replace its backup secret'));
    }
    generatedSecret = generateRecoverySecret();
    return text({ recoverySecret: generatedSecret, storeOutsideRelay: true,
      warning: 'Save this secret in the agent secret manager. Losing it makes the encrypted backup unusable.' });
  });

  server.registerTool('wallet_create', {
    description: 'Generate a Base wallet key locally and encrypt it under the agent-held recovery secret before returning.',
    inputSchema: z.object({}),
  }, async () => {
    try {
      if (!wallet) {
        const secret = newRecoverySecret();
        if (memoryOnly) {
          if ((await relayBackupKeys()).length !== 0) {
            throw new Error('An encrypted Relay wallet backup already exists; restore it instead');
          }
        } else if (await localStore().get()) {
          throw new Error('An encrypted wallet vault already exists; restore it instead');
        }
        const created = dependencies.createWallet?.() ?? AgentWallet.create(options);
        const store = memoryOnly ? relayStore(created.address) : localStore();
        await created.backupToStore(secret, store);
        if (options.spendStore instanceof FileSpendStore) {
          await options.spendStore.initialize(created.address, created.network);
        }
        wallet = created;
        const backupKey = store instanceof RelayWalletBackupStore ? store.backupKey : undefined;
        return text({ address: wallet.address, network: wallet.network, custody: 'local',
          backupLocation: memoryOnly ? 'relay-memory' : 'local-encrypted-vault',
          backupKey, keepRecoverySecret: true });
      }
      return text({ address: wallet.address, network: wallet.network, custody: 'local',
        backupLocation: memoryOnly ? 'relay-memory' : 'local-encrypted-vault',
        keepRecoverySecret: true });
    } catch (error) { return fail(error); }
  });

  server.registerTool('wallet_address', {
    description: 'Get the locally held wallet address.',
    inputSchema: z.object({}),
  }, async () => {
    try { return text({ address: requireWallet().address }); } catch (error) { return fail(error); }
  });

  server.registerTool('wallet_receive_info', {
    description: 'Get the USDC receiving address and Base network information.',
    inputSchema: z.object({}),
  }, async () => {
    try { return text(requireWallet().receiveInfo()); } catch (error) { return fail(error); }
  });

  server.registerTool('wallet_funding_request', {
    description: 'Locally generate a Base USDC EIP-681 funding URI and SVG QR for this wallet. This does not sign or submit a transfer.',
    inputSchema: z.object({
      amountUsdc: z.string().optional(),
      expectedChainId: z.number().int().optional(),
    }).strict(),
  }, async ({ amountUsdc, expectedChainId }) => {
    try { return text(await requireWallet().fundingRequest({ amountUsdc, expectedChainId })); }
    catch (error) { return fail(error); }
  });

  server.registerTool('wallet_prepare_voidly_seller_registration', {
    description: 'Fetch and sign only Voidly\'s exact seller-registration SIWE challenge; return the fixed submit URL and body without submitting.',
    inputSchema: z.object({}).strict(),
  }, async () => {
    try { return text(await requireWallet().prepareVoidlySellerRegistration()); }
    catch (error) { return fail(error); }
  });

  server.registerTool('wallet_balance', {
    description: 'Read the wallet USDC balance from the configured Base RPC.',
    inputSchema: z.object({}),
  }, async () => {
    try { return text(await requireWallet().balance()); } catch (error) { return fail(error); }
  });

  server.registerTool('wallet_pay_x402', {
    description: 'Pay a public HTTPS x402 resource with local USDC authorization, within configured per-call and daily limits.',
    inputSchema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST']).optional(),
      body: z.unknown().optional(),
      maxAmountUsd: z.string().optional(),
    }),
  }, async ({ url, method, body, maxAmountUsd }) => {
    try { return text(await boundedResponse(await requireWallet().payX402({ url, method, body, maxAmountUsd }),
      dependencies.responseBodyDeadlineMsForTests ?? 15_000)); }
    catch (error) {
      if (error instanceof PaymentMayHaveSettledError) return text(error.toResult());
      return fail(error);
    }
  });

  server.registerTool('wallet_marketplace_attempts', {
    description: 'List locally retained Marketplace quote and payment keys for payer-authenticated recovery; never retries or pays.',
    inputSchema: z.object({}),
  }, async () => {
    try { return text({ attempts: await requireWallet().marketplaceAttempts() }); }
    catch (error) { return fail(error); }
  });

  server.registerTool('wallet_recover_marketplace', {
    description: 'Sign a fresh payer recovery request for a locally retained Marketplace attempt; never sends a payment retry.',
    inputSchema: z.object({ quoteId: z.string().regex(/^0x[0-9a-f]{64}$/) }),
  }, async ({ quoteId }) => {
    try {
      const recovered = await requireWallet().recoverMarketplace(quoteId);
      return text({ ...await boundedResponse(recovered.response,
        dependencies.responseBodyDeadlineMsForTests ?? 15_000),
      quoteId: recovered.quoteId, verifiedStatus: recovered.verifiedStatus,
      archivePending: recovered.archivePending,
      archiveWarning: recovered.archivePending
        ? 'Signed outcome verified, but local archival failed. Preserve this receipt and recover the original quote again; do not pay again.'
        : null });
    }
    catch (error) { return fail(error); }
  });

  server.registerTool('wallet_backup_relay', {
    description: 'Encrypt the local key with the agent-held recovery secret, then store only ciphertext in Relay memory.',
    inputSchema: z.object({}),
  }, async () => {
    try {
      const current = requireWallet();
      const store = relayStore(current.address);
      await current.backupToStore(newRecoverySecret(), store);
      return text({ backedUp: true, location: 'relay-memory',
        backupKey: store instanceof RelayWalletBackupStore ? store.backupKey : undefined,
        secretRequiredForRecovery: true });
    } catch { return fail(new Error('Wallet backup failed; check local Relay credentials and recovery secret')); }
  });

  server.registerTool('wallet_restore_local', {
    description: 'Restore the local encrypted vault with the agent-held recovery secret.',
    inputSchema: z.object({}),
  }, async () => {
    try {
      if (wallet) throw new Error('A wallet is already loaded');
      const restored = await AgentWallet.restoreFromStore(recoverySecret(), localStore(), options);
      if (options.spendStore instanceof FileSpendStore) {
        await options.spendStore.initialize(restored.address, restored.network, true);
      }
      wallet = restored;
      return text({ restored: true, address: wallet.address, network: wallet.network });
    } catch { return fail(new Error('Wallet restore failed; check the local encrypted vault and recovery secret')); }
  });

  server.registerTool('wallet_restore_relay', {
    description: 'Restore the wallet locally from client-encrypted Relay memory using the agent-held recovery secret.',
    inputSchema: z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      backupKey: z.string().regex(/^0x[0-9a-f]{40}\.[0-9a-f]{32}$/).optional(),
    }),
  }, async ({ address, backupKey }) => {
    try {
      if (wallet) throw new Error('A wallet is already loaded');
      let selectedKey = backupKey;
      if (!selectedKey) {
        const keys = (await relayBackupKeys()).filter(key => {
          const keyAddress = RelayWalletBackupStore.addressFromBackupKey(key);
          return keyAddress && (!address || keyAddress === address.toLowerCase());
        });
        if (keys.length === 0) throw new Error('No matching Relay wallet backup found');
        if (keys.length > 1) throw new Error(`Multiple Relay wallet backups found; provide backupKey: ${keys.join(', ')}`);
        selectedKey = keys[0]!;
      }
      const selectedAddress = RelayWalletBackupStore.addressFromBackupKey(selectedKey);
      if (!selectedAddress || address && selectedAddress !== address.toLowerCase()) throw new Error('Relay backup key does not match requested address');
      const restored = await AgentWallet.restoreFromStore(recoverySecret(), relayStore(selectedAddress, selectedKey), options);
      if (restored.address.toLowerCase() !== selectedAddress) throw new Error('Relay backup address does not match decrypted wallet');
      if (options.spendStore instanceof FileSpendStore) {
        await options.spendStore.initialize(restored.address, restored.network, true);
      }
      wallet = restored;
      return text({ restored: true, address: wallet.address, network: wallet.network, backupKey: selectedKey });
    } catch (error) { return fail(error); }
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const server = createWalletMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
