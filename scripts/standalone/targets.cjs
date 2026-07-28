'use strict';

const PINNED_BUN_VERSION = '1.3.14';

const TARGETS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    target: 'aarch64-apple-darwin',
    bunTarget: 'bun-darwin-arm64',
    platformName: 'macos-arm64',
    standaloneAsset: 'openchrome-macos-arm64',
    extension: '',
  }),
  'x86_64-apple-darwin': Object.freeze({
    target: 'x86_64-apple-darwin',
    bunTarget: 'bun-darwin-x64',
    platformName: 'macos-x64',
    standaloneAsset: 'openchrome-macos-x64',
    extension: '',
  }),
  'x86_64-pc-windows-msvc': Object.freeze({
    target: 'x86_64-pc-windows-msvc',
    bunTarget: 'bun-windows-x64',
    platformName: 'windows-x64',
    standaloneAsset: 'openchrome-windows-x64.exe',
    extension: '.exe',
  }),
  'x86_64-unknown-linux-gnu': Object.freeze({
    target: 'x86_64-unknown-linux-gnu',
    bunTarget: 'bun-linux-x64',
    platformName: 'linux-x64',
    standaloneAsset: 'openchrome-linux-x64',
    extension: '',
  }),
});

const ALIASES = new Map();
for (const value of Object.values(TARGETS)) {
  ALIASES.set(value.target, value.target);
  ALIASES.set(value.bunTarget, value.target);
  ALIASES.set(value.platformName, value.target);
}

function currentTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const mapping = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
  };
  const target = mapping[key];
  if (!target) throw new Error(`Unsupported standalone target: ${key}`);
  return target;
}

function resolveTarget(input) {
  const target = input ? ALIASES.get(input) : currentTarget();
  if (!target || !TARGETS[target]) {
    throw new Error(`Unknown target: ${input || '(current platform)'}`);
  }
  return TARGETS[target];
}

function outputName(target, kind) {
  if (kind === 'standalone') return target.standaloneAsset;
  if (kind === 'sidecar') return `openchrome-sidecar-${target.target}${target.extension}`;
  throw new Error(`Unknown build kind: ${kind}`);
}

module.exports = {
  PINNED_BUN_VERSION,
  TARGETS,
  currentTarget,
  resolveTarget,
  outputName,
};
