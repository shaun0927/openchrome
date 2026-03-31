#!/usr/bin/env node
/**
 * Build the OpenChrome sidecar binary for the current platform.
 * Uses `pkg` to bundle the Node.js server into a standalone executable.
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const repoRoot = path.resolve(__dirname, "..", "..");
const binDir = path.resolve(__dirname, "..", "src-tauri", "binaries");
const entryPoint = path.resolve(repoRoot, "dist", "index.js");

function getTauriTarget() {
  const p = os.platform(), a = os.arch();
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`Unsupported platform: ${p}-${a}`);
}

const args = process.argv.slice(2);
const targetIdx = args.indexOf("--target");
const target = targetIdx !== -1 ? args[targetIdx + 1] : getTauriTarget();

const pkgTargets = {
  "aarch64-apple-darwin": "node18-macos-arm64",
  "x86_64-apple-darwin": "node18-macos-x64",
  "x86_64-pc-windows-msvc": "node18-win-x64",
  "x86_64-unknown-linux-gnu": "node18-linux-x64",
};
const pkgTarget = pkgTargets[target];
if (!pkgTarget) { console.error(`Unknown target: ${target}`); process.exit(1); }
if (!fs.existsSync(entryPoint)) {
  console.error("Run 'npm run build' in repo root first."); process.exit(1);
}

fs.mkdirSync(binDir, { recursive: true });
const ext = target.includes("windows") ? ".exe" : "";
const outputPath = path.resolve(binDir, `openchrome-sidecar-${target}${ext}`);

console.error(`Building sidecar: ${target} -> ${outputPath}`);
try {
  execSync(`npx pkg "${entryPoint}" --target ${pkgTarget} --output "${outputPath}" --compress GZip`, {
    cwd: repoRoot, stdio: "inherit",
  });
  if (!target.includes("windows")) fs.chmodSync(outputPath, 0o755);
  console.error("Sidecar built successfully");
} catch (err) {
  console.error("Failed to build sidecar:", err.message);
  process.exit(1);
}
