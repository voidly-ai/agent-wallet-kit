#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { network, parseOptions, required, runCli } from './cli-runner.mjs';

const SAMPLE_LISTING = fileURLToPath(new URL('./listing.example.json', import.meta.url));

export function buildSellArgs(argv) {
  const { values, switches } = parseOptions(argv, ['listing', 'network', 'secret-file'], ['submit']);
  const listing = required(values, 'listing');
  if (switches.has('submit') && resolve(listing) === SAMPLE_LISTING) {
    throw new Error('Copy and replace the included listing template before --submit');
  }
  const args = ['sell', '--network', network(values), '--listing', listing];
  if (values.has('secret-file')) args.push('--secret-file', required(values, 'secret-file'));
  if (!switches.has('submit')) args.push('--dry-run');
  return args;
}

export function runSell(argv, options = {}) {
  return runCli(buildSellArgs(argv), options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = runSell(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Example failed'}\n`); process.exitCode = 1; }
}
