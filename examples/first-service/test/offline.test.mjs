import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBuyArgs, runBuy } from '../buy-first-service.mjs';
import { buildSellArgs, runSell } from '../sell-first-service.mjs';

const buyFlags = [
  '--listing-id', 'seller_12345678', '--version', '2', '--input', 'input.example.json',
  '--per-call-usdc', '0.10', '--daily-usdc', '1.00', '--max-usdc', '0.05',
];

test('buy defaults to Sepolia dry-run and requires self-set caps', () => {
  assert.deepEqual(buildBuyArgs(buyFlags), [
    'buy', 'seller_12345678', '--network', 'base-sepolia', '--version', '2',
    '--input', 'input.example.json', '--per-call-usdc', '0.10',
    '--daily-usdc', '1.00', '--max-usdc', '0.05', '--dry-run',
  ]);
  assert.throws(() => buildBuyArgs(buyFlags.slice(0, -2)), /--max-usdc is required/);
  assert.throws(() => buildBuyArgs([...buyFlags, '--pay', '--pay']), /Repeated option/);
});

test('buy needs explicit mainnet and pay switches; arguments stay literal', () => {
  const input = 'request-$(touch should-not-run).json';
  const args = buildBuyArgs([...buyFlags.slice(0, 5), input, ...buyFlags.slice(6), '--network', 'base', '--pay']);
  assert.equal(args[3], 'base');
  assert.equal(args[7], input);
  assert.equal(args.includes('--dry-run'), false);
});

test('sell defaults to Sepolia dry-run and refuses the included template on submit', () => {
  assert.deepEqual(buildSellArgs(['--listing', 'listing.example.json']), [
    'sell', '--network', 'base-sepolia', '--listing', 'listing.example.json', '--dry-run',
  ]);
  const template = fileURLToPath(new URL('../listing.example.json', import.meta.url));
  assert.throws(() => buildSellArgs(['--listing', template, '--submit']), /Copy and replace/);
  assert.deepEqual(buildSellArgs(['--listing', 'seller.json', '--network', 'base', '--submit']), [
    'sell', '--network', 'base', '--listing', 'seller.json',
  ]);
});

test('wrappers invoke one child without a shell and preserve uncertain result codes', () => {
  const calls = [];
  const output = [];
  const io = {
    spawnSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 3, stdout: '{"bodyComplete":false,"doNotRepay":true}\n', stderr: '' };
    },
    stdout: { write: value => output.push(value) },
    stderr: { write: value => output.push(value) },
  };
  assert.equal(runBuy([...buyFlags, '--pay'], io), 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.includes('--dry-run'), false);
  assert.deepEqual(output, ['{"bodyComplete":false,"doNotRepay":true}\n']);

  calls.length = 0;
  assert.equal(runSell(['--listing', 'seller.json', '--submit'], io), 3);
  assert.equal(calls.length, 1);
});
