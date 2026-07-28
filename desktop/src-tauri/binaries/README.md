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

The script (`desktop/scripts/build-sidecar.js`) delegates to the canonical
root standalone builder. Bun bundles both `dist/cli/index.js` and
`dist/index.js` into one executable, then writes it here with the correct
Tauri target suffix, e.g. `openchrome-sidecar-aarch64-apple-darwin`.

## Supported platforms

| Tauri target                    | Bun target           |
|---------------------------------|----------------------|
| `aarch64-apple-darwin`          | `bun-darwin-arm64`  |
| `x86_64-apple-darwin`           | `bun-darwin-x64`    |
| `x86_64-pc-windows-msvc`        | `bun-windows-x64`   |
| `x86_64-unknown-linux-gnu`      | `bun-linux-x64`     |

Release certification still runs each executable on its native target runner,
even though Bun can produce cross-target executables.
