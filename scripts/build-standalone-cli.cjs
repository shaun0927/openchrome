#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  PINNED_BUN_VERSION,
  resolveTarget,
  outputName,
} = require('./standalone/targets.cjs');

const repoRoot = path.resolve(__dirname, '..');

function usage() {
  process.stdout.write(`Usage: node scripts/build-standalone-cli.cjs [options]\n\n` +
    `Options:\n` +
    `  --target <target>       Tauri triple, Bun target, or platform name\n` +
    `  --kind <kind>           standalone (default) or sidecar\n` +
    `  --output-dir <path>     Output directory (default: artifacts/standalone)\n` +
    `  --tag <vX.Y.Z>          Fail unless the tag matches package.json\n` +
    `  --bun-bin <path>        Bun executable (default: bun)\n` +
    `  --help                  Show this help\n`);
}

function parseArgs(argv) {
  const options = {
    kind: 'standalone',
    outputDir: path.join(repoRoot, 'artifacts', 'standalone'),
    bunBin: process.env.BUN_BIN || 'bun',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { ...options, help: true };
    if (arg === '--target') options.target = argv[++index];
    else if (arg === '--kind') options.kind = argv[++index];
    else if (arg === '--output-dir') options.outputDir = path.resolve(argv[++index]);
    else if (arg === '--tag') options.tag = argv[++index];
    else if (arg === '--bun-bin') options.bunBin = argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['standalone', 'sidecar'].includes(options.kind)) {
    throw new Error(`Unknown build kind: ${options.kind}`);
  }
  return options;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourceCommit() {
  if (/^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA || '')) return process.env.GITHUB_SHA;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function ensureCanonicalBuild() {
  for (const relativePath of ['dist/index.js', 'dist/cli/index.js']) {
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      throw new Error(`Missing ${relativePath}; run npm run build before standalone compilation.`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (options.tag && options.tag !== `v${version}`) {
    throw new Error(`Release tag ${options.tag} does not match package.json version v${version}.`);
  }

  ensureCanonicalBuild();
  const target = resolveTarget(options.target);
  const bunVersion = execFileSync(options.bunBin, ['--version'], { encoding: 'utf8' }).trim();
  if (bunVersion !== PINNED_BUN_VERSION) {
    throw new Error(`Bun ${PINNED_BUN_VERSION} is required; found ${bunVersion}.`);
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  const assetName = outputName(target, options.kind);
  const outputPath = path.join(options.outputDir, assetName);
  const metafilePath = `${outputPath}.metafile.json`;
  const commit = sourceCommit();
  const bundler = `bun-${bunVersion}`;
  const env = {
    ...process.env,
    OPENCHROME_BUILD_VERSION: version,
    OPENCHROME_BUILD_COMMIT: commit,
    OPENCHROME_BUILD_TARGET: target.target,
    OPENCHROME_BUILD_BUNDLER: bundler,
  };

  const buildArgs = [
    'build',
    path.join(repoRoot, 'scripts', 'standalone', 'entry.cjs'),
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${outputPath}`,
    `--metafile=${metafilePath}`,
    '--env=OPENCHROME_BUILD_*',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--no-compile-autoload-package-json',
  ];
  if (target.extension === '.exe') {
    buildArgs.push('--windows-title=OpenChrome', `--windows-version=${version}.0`, '--windows-description=OpenChrome MCP CLI');
  }

  const build = spawnSync(options.bunBin, buildArgs, { cwd: repoRoot, env, stdio: 'inherit' });
  if (build.status !== 0) throw new Error(`Bun compilation failed with exit ${build.status}.`);
  if (target.extension !== '.exe') fs.chmodSync(outputPath, 0o755);

  const digest = sha256(outputPath);
  const checksumPath = `${outputPath}.sha256`;
  fs.writeFileSync(checksumPath, `${digest}  ${assetName}\n`);
  const metadata = {
    schemaVersion: 1,
    version,
    sourceCommit: commit,
    target: target.target,
    platformName: target.platformName,
    bunTarget: target.bunTarget,
    bundler,
    asset: assetName,
    sizeBytes: fs.statSync(outputPath).size,
    sha256: digest,
  };
  const metadataPath = `${outputPath}.metadata.json`;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, checksumPath, metadataPath, metadata })}\n`);
}

function cleanupBunTemps() {
  for (const name of fs.readdirSync(repoRoot)) {
    if (/^\.[0-9a-f]+-[0-9a-f]+\.bun-build$/i.test(name)) {
      fs.unlinkSync(path.join(repoRoot, name));
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`[standalone-build] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  cleanupBunTemps();
}
