#!/usr/bin/env node
/**
 * Bin-entry audit: pack the npm tarball, extract it, and assert that the
 * `bin.openchrome` field resolves to an executable JS file starting with
 * #!/usr/bin/env node.
 *
 * Linux/macOS only. Windows uses npm-generated .cmd shims and is explicitly
 * out of scope for this assertion — npm handles cross-platform bin wrapping
 * and openchrome does not need to replicate it.
 *
 * Usage (from repo root):
 *   node scripts/verify/A6-bin-entry.mjs
 */

import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

if (process.platform === 'win32') {
  console.log('[A6-bin-entry] SKIP: Windows platform — npm .cmd shim handles bin wrapping.');
  process.exit(0);
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function fail(msg) {
  console.error(`[A6-bin-entry] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[A6-bin-entry] OK: ${msg}`);
}

// Read package.json to get the expected bin path
const pkgJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const binField = pkgJson.bin;
if (!binField || typeof binField !== 'object') {
  fail('package.json has no "bin" object field');
}

const binEntries = Object.entries(binField);
if (binEntries.length === 0) {
  fail('package.json "bin" field is empty');
}

// Work in a temp directory
const workDir = mkdtempSync(join(tmpdir(), 'oc-bin-audit-'));

try {
  // Pack the tarball
  console.log('[A6-bin-entry] Running npm pack...');
  const packResult = spawnSync('npm', ['pack', '--pack-destination', workDir], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (packResult.status !== 0) {
    fail(`npm pack failed:\n${packResult.stderr}`);
  }

  // Find the .tgz
  const tgzFiles = readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
  if (tgzFiles.length === 0) {
    fail(`No .tgz file found in ${workDir} after npm pack`);
  }
  const tgzPath = join(workDir, tgzFiles[0]);
  ok(`packed: ${tgzFiles[0]}`);

  // Extract
  const extractDir = join(workDir, 'extracted');
  execSync(`mkdir -p "${extractDir}" && tar -xzf "${tgzPath}" -C "${extractDir}"`, { stdio: 'inherit' });

  // npm pack wraps contents under a "package/" directory
  const packageDir = join(extractDir, 'package');

  // Verify each bin entry
  for (const [binName, binRelPath] of binEntries) {
    const fullPath = join(packageDir, binRelPath);

    // File must exist
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      fail(`bin.${binName} => "${binRelPath}" does not exist in the packed tarball (looked for ${fullPath})`);
    }

    if (!stat.isFile()) {
      fail(`bin.${binName} => "${binRelPath}" is not a file`);
    }

    // File must start with #!/usr/bin/env node
    const content = readFileSync(fullPath, 'utf8');
    const firstLine = content.split('\n')[0];
    if (firstLine !== '#!/usr/bin/env node') {
      fail(`bin.${binName} => "${binRelPath}" shebang mismatch.\n  Expected: #!/usr/bin/env node\n  Got:      ${firstLine}`);
    }

    ok(`bin.${binName} => "${binRelPath}" exists with correct shebang`);

    // Note: npm automatically sets the executable bit when installing bin entries
    // via `npm install -g` or `npm link`. The packed tarball may have mode 644;
    // that is expected and correct. We only verify the shebang is present so
    // Node can run the file when invoked via `node <path>`.
    const mode = stat.mode;
    ok(`bin.${binName} is present (mode: ${(mode & 0o777).toString(8)}, npm sets +x on install)`);
  }

  console.log('[A6-bin-entry] All bin-entry checks passed.');
} finally {
  // Clean up temp dir
  try {
    execSync(`rm -rf "${workDir}"`);
  } catch {
    // non-fatal cleanup failure
  }
}
