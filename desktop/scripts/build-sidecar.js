#!/usr/bin/env node

/**
 * Build the OpenChrome sidecar binary for the current platform.
 *
 * Uses `pkg` to bundle the Node.js server into a standalone executable
 * that Tauri can manage as a sidecar process.
 *
 * Usage: node scripts/build-sidecar.js [--target <platform>]
 *
 * Platform suffixes follow Tauri conventions:
 *   - aarch64-apple-darwin     (macOS ARM64)
 *   - x86_64-apple-darwin      (macOS Intel)
 *   - x86_64-pc-windows-msvc   (Windows x64)
 *   - x86_64-unknown-linux-gnu (Linux x64)
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Resolve paths
const repoRoot = path.resolve(__dirname, "..", "..");
const desktopDir = path.resolve(__dirname, "..");
const binDir = path.resolve(desktopDir, "src-tauri", "binaries");
const entryPoint = path.resolve(repoRoot, "dist", "index.js");

// Map Node.js platform/arch to Tauri sidecar suffix
function getTauriTarget() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

// Parse CLI args
const args = process.argv.slice(2);
const targetIdx = args.indexOf("--target");
const target = targetIdx !== -1 ? args[targetIdx + 1] : getTauriTarget();

// Map Tauri target to pkg target
function getPkgTarget(tauriTarget) {
  const map = {
    "aarch64-apple-darwin": "node18-macos-arm64",
    "x86_64-apple-darwin": "node18-macos-x64",
    "x86_64-pc-windows-msvc": "node18-win-x64",
    "x86_64-unknown-linux-gnu": "node18-linux-x64",
  };
  return map[tauriTarget] || null;
}

const pkgTarget = getPkgTarget(target);
if (!pkgTarget) {
  console.error(`Unknown target: ${target}`);
  process.exit(1);
}

// Ensure dist/index.js exists
if (!fs.existsSync(entryPoint)) {
  console.error("Entry point not found. Run 'npm run build' in repo root first.");
  console.error(`Expected: ${entryPoint}`);
  process.exit(1);
}

// Ensure binaries directory exists
fs.mkdirSync(binDir, { recursive: true });

// Output binary name (Tauri expects this naming convention)
const ext = target.includes("windows") ? ".exe" : "";
const outputName = `openchrome-sidecar-${target}${ext}`;
const outputPath = path.resolve(binDir, outputName);

console.log(`Building sidecar for: ${target}`);
console.log(`  pkg target: ${pkgTarget}`);
console.log(`  entry: ${entryPoint}`);
console.log(`  output: ${outputPath}`);

try {
  execSync(
    `npx pkg "${entryPoint}" --target ${pkgTarget} --output "${outputPath}" --compress GZip`,
    {
      cwd: repoRoot,
      stdio: "inherit",
    }
  );
  console.log(`\nSidecar built successfully: ${outputPath}`);

  // Make executable on Unix
  if (!target.includes("windows")) {
    fs.chmodSync(outputPath, 0o755);
  }
} catch (err) {
  console.error("Failed to build sidecar:", err.message);
  process.exit(1);
}
