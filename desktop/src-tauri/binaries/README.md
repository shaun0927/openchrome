# Sidecar Binaries

This directory holds platform-specific sidecar executables bundled by Tauri.
Binaries are **built locally and not committed to git**.

## Building the sidecar

From the repo root, ensure the CLI is compiled first:

```bash
npm run build
```

Then build the sidecar for the current platform from the `desktop/` directory:

```bash
cd desktop
npm run build:sidecar
```

The script (`desktop/scripts/build-sidecar.js`) uses `pkg` to bundle
`dist/cli/index.js` into a standalone executable and writes it here with the
correct Tauri target suffix, e.g. `openchrome-sidecar-aarch64-apple-darwin`.

## Supported platforms

| Tauri target                    | pkg target           |
|---------------------------------|----------------------|
| `aarch64-apple-darwin`          | `node18-macos-arm64` |
| `x86_64-apple-darwin`           | `node18-macos-x64`   |
| `x86_64-pc-windows-msvc`        | `node18-win-x64`     |
| `x86_64-unknown-linux-gnu`      | `node18-linux-x64`   |

Cross-compilation is not supported by `pkg`; build on each target platform
natively, or use CI runners for each OS.
