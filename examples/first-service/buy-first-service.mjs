#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { network, parseOptions, required, runCli } from './cli-runner.mjs';

export function buildBuyArgs(argv) {
  const { values, switches } = parseOptions(argv,
    ['listing-id', 'version', 'input', 'per-call-usdc', 'daily-usdc', 'max-usdc', 'network'],
    ['pay']);
  const listingId = required(values, 'listing-id');
  if (!/^[a-z0-9][a-z0-9_-]{7,63}$/.test(listingId)) throw new Error('Invalid listing ID');
  const version = required(values, 'version');
  if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) {
    throw new Error('--version must be a positive integer');
  }
  const args = [
    'buy', listingId,
    '--network', network(values),
    '--version', version,
    '--input', required(values, 'input'),
    '--per-call-usdc', required(values, 'per-call-usdc'),
    '--daily-usdc', required(values, 'daily-usdc'),
    '--max-usdc', required(values, 'max-usdc'),
  ];
  if (!switches.has('pay')) args.push('--dry-run');
  return args;
}

export function runBuy(argv, options = {}) {
  return runCli(buildBuyArgs(argv), options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = runBuy(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Example failed'}\n`); process.exitCode = 1; }
}
