import assert from 'node:assert/strict';
import test from 'node:test';
import { runWalletCli, type WalletCliDependencies } from '../src/cli.js';

type Guide = {
  schema: string; command: string; mode: string; package: { version: string }; network: string; gateway: string;
  effects: Record<string, boolean>; approval: { requiredBeforeExecution: boolean; instruction: string; mcp: string };
  buy: { dryRunArgv: string[]; executeAfterApprovalArgv: string[]; mcp: { requiresConfirmTrue: boolean } };
  sell: { dryRunArgv: string[]; executeAfterApprovalArgv: string[]; mcp: { requiresConfirmTrue: boolean };
    recovery: { automaticRetry: boolean; resumeAfterApprovalArgv: string[]; instruction: string } };
  buyerRecovery: { heldHttpStatuses: number[]; automaticRetry: boolean; doNotRepay: boolean;
    instruction: string; recoverOriginalArgv: string[]; terminalCheck: string };
  surfaces: { localWalletMcp: { transport: string; registryName: string };
    hostedMcp: { transport: string; registryName: string }; evidence: string };
};

// Fail if quickstart even inspects an environment/fetch/restore dependency.
const noEffects = new Proxy({} as WalletCliDependencies, {
  get: (_target, property) => { throw new Error(`Unexpected dependency access: ${String(property)}`); },
});

async function guide(args: string[] = []): Promise<Guide> {
  return await runWalletCli(['quickstart', ...args], noEffects) as unknown as Guide;
}

test('quickstart is an offline Sepolia guide with both workflows and explicit host approval', async () => {
  const result = await guide();
  assert.equal(result.schema, 'voidly-wallet-quickstart/v1');
  assert.equal(result.command, 'quickstart');
  assert.equal(result.mode, 'guide_only');
  assert.equal(result.package.version, '0.5.1');
  assert.equal(result.network, 'base-sepolia');
  assert.equal(result.gateway, 'https://x402-staging.voidly.ai');
  assert.equal(Object.values(result.effects).every(value => value === false), true);
  assert.equal(result.approval.requiredBeforeExecution, true);
  assert.match(result.approval.instruction, /approve each exact buy or sell/);
  assert.match(result.approval.mcp, /only after the host obtains user approval/);
  for (const workflow of [result.buy, result.sell]) {
    assert.deepEqual(workflow.dryRunArgv, [...workflow.executeAfterApprovalArgv, '--dry-run']);
    assert.equal(workflow.mcp.requiresConfirmTrue, true);
    const at = workflow.executeAfterApprovalArgv.indexOf('--network');
    assert.equal(workflow.executeAfterApprovalArgv[at + 1], 'base-sepolia');
  }
  for (const flag of ['--version', '--input', '--per-call-usdc', '--daily-usdc', '--max-usdc']) {
    const at = result.buy.executeAfterApprovalArgv.indexOf(flag);
    assert.ok(at > 0);
    assert.match(result.buy.executeAfterApprovalArgv[at + 1]!, /^<.+>$/);
  }
  assert.equal(result.sell.executeAfterApprovalArgv.includes('--quickstart'), true);
  assert.equal(result.sell.executeAfterApprovalArgv.includes('--listing'), true);
});

test('quickstart selects a mainnet guide only when explicitly requested and rejects executable options', async () => {
  const mainnet = await guide(['--network', 'base']);
  assert.equal(mainnet.network, 'base');
  assert.equal(mainnet.gateway, 'https://x402.voidly.ai');
  assert.equal(mainnet.mode, 'guide_only');
  for (const args of [
    ['--network', 'ethereum'], ['--network'], ['--network', 'base', '--network', 'base-sepolia'],
    ['buy'], ['--execute'], ['--confirm', 'true'], ['--input', '/private/input.json'],
    ['--listing', '/private/listing.json'], ['--dry-run'], ['--url', 'https://untrusted.example'],
  ]) await assert.rejects(guide(args));
  const usage = await runWalletCli(['help'], noEffects);
  assert.match(String(usage.usage), /voidly-agent-wallet quickstart/);
});

test('quickstart preserves original buyer and seller recovery identities without automatic retry', async () => {
  for (const network of ['base', 'base-sepolia']) {
    const result = await guide(['--network', network]);
    assert.deepEqual(result.buyerRecovery.heldHttpStatuses, [202, 503]);
    assert.equal(result.buyerRecovery.automaticRetry, false);
    assert.equal(result.buyerRecovery.doNotRepay, true);
    assert.match(result.buyerRecovery.instruction, /original quoteId, paymentKey, wallet, network/);
    assert.match(result.buyerRecovery.instruction, /never rerun buy/);
    assert.deepEqual(result.buyerRecovery.recoverOriginalArgv,
      ['voidly-agent-wallet', 'recover', '<ORIGINAL_QUOTE_ID>', '--network', network]);
    assert.match(result.buyerRecovery.terminalCheck, /refund_owed is an obligation, not a completed refund/);
    assert.equal(result.sell.recovery.automaticRetry, false);
    assert.match(result.sell.recovery.instruction, /Never allocate a new idempotency key/);
    assert.deepEqual(result.sell.recovery.resumeAfterApprovalArgv,
      [...result.sell.executeAfterApprovalArgv, '--resume-file', '<ORIGINAL_PRIVATE_INTENT_JSON>']);
  }
});

test('quickstart keeps local stdio and hosted Registry evidence separate and returns fresh guides', async () => {
  const result = await guide();
  assert.equal(result.surfaces.localWalletMcp.transport, 'stdio');
  assert.equal(result.surfaces.localWalletMcp.registryName, 'io.github.voidly-ai/agent-wallet-kit');
  assert.equal(result.surfaces.hostedMcp.transport, 'streamable-http');
  assert.equal(result.surfaces.hostedMcp.registryName, 'io.github.voidly-ai/voidly-hosted');
  assert.match(result.surfaces.evidence, /This offline guide checks none of them/);
  result.buy.executeAfterApprovalArgv.push('--execute');
  assert.equal((await guide()).buy.executeAfterApprovalArgv.includes('--execute'), false);
});
