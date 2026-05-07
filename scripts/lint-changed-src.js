#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = { base: process.env.LINT_CHANGED_BASE || 'origin/develop' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base' && argv[i + 1]) {
      args.base = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--base=')) {
      args.base = arg.slice('--base='.length);
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    if (options.optional) return '';
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    throw new Error(`git ${args.join(' ')} failed${stderr}`);
  }
  return result.stdout || '';
}

function gitSucceeds(args) {
  return spawnSync('git', args, { stdio: 'ignore' }).status === 0;
}

function diffNames(args, options = {}) {
  return runGit(['diff', '--name-only', '--diff-filter=ACMR', ...args, '--', 'src'], options)
    .split(/\r?\n/)
    .filter(Boolean);
}

function untrackedSrcFiles() {
  return runGit(['ls-files', '--others', '--exclude-standard', '--', 'src'], { quiet: true })
    .split(/\r?\n/)
    .filter(Boolean);
}

function changedSrcTsFiles(base) {
  const files = new Set();

  if (!gitSucceeds(['rev-parse', '--verify', `${base}^{commit}`])) {
    throw new Error(`Configured lint base ${base} is not available. Fetch it or pass --base <ref>.`);
  }

  // PR/branch changes relative to the configured base. Prefer merge-base diff;
  // fall back to a direct diff only when the histories have no merge base.
  let baseDiff = diffNames([`${base}...HEAD`], { optional: true, quiet: true });
  if (baseDiff.length === 0 && !gitSucceeds(['merge-base', base, 'HEAD'])) {
    baseDiff = diffNames([base, 'HEAD']);
  }
  for (const file of baseDiff) files.add(file);

  // Include local edits so the guardrail is useful before committing.
  for (const file of diffNames([])) files.add(file);
  for (const file of diffNames(['--cached'])) files.add(file);
  for (const file of untrackedSrcFiles()) files.add(file);

  return [...files]
    .filter((file) => /^src\/.*\.ts$/.test(file))
    .sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run lint:changed -- [--base origin/develop]');
    console.log('Lints changed src/**/*.ts files with ESLint warnings treated as failures.');
    return 0;
  }

  const files = changedSrcTsFiles(args.base);
  if (files.length === 0) {
    console.log(`No changed src/**/*.ts files detected against ${args.base}.`);
    return 0;
  }

  console.log(`Linting ${files.length} changed src/**/*.ts file(s) against ${args.base}:`);
  for (const file of files) console.log(`- ${file}`);

  const eslintBin = require('path').join(
    require('path').dirname(require.resolve('eslint/package.json')),
    'bin',
    'eslint.js',
  );
  const result = spawnSync(process.execPath, [eslintBin, ...files, '--max-warnings=0'], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
