import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export function parseOptions(argv, valueNames, switchNames) {
  const values = new Map();
  const switches = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (values.has(name) || switches.has(name)) throw new Error(`Repeated option: ${flag}`);
    if (switchNames.includes(name)) {
      switches.add(name);
      continue;
    }
    if (!valueNames.includes(name)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values.set(name, value);
  }
  return { values, switches };
}

export function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function network(values) {
  const selected = values.get('network') ?? 'base-sepolia';
  if (selected !== 'base-sepolia' && selected !== 'base') {
    throw new Error('--network must be base-sepolia or base');
  }
  return selected;
}

export function runCli(args, options = {}) {
  const run = options.spawnSyncFn ?? spawnSync;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const result = run(process.execPath, [CLI, ...args], {
    shell: false,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return Number.isInteger(result.status) ? result.status : 1;
}
