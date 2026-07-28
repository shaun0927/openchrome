# Standalone OpenChrome CLI

OpenChrome releases may include optional self-contained CLI executables. These
artifacts run the same MCP and command surfaces as the npm package without a
separately installed Node.js or npm runtime.

The standalone CLI is additive:

- npm remains the broadest installation path;
- the desktop app continues to use the same sidecar build pipeline;
- Chrome or Chromium is not bundled;
- only assets present on a specific release are certified for that release.

## Certified asset names

| Platform | Asset |
| --- | --- |
| macOS Apple Silicon | `openchrome-macos-arm64` |
| macOS Intel | `openchrome-macos-x64` |
| Windows x64 | `openchrome-windows-x64.exe` |
| Linux x64 | `openchrome-linux-x64` |

Every executable has a sibling `.sha256` file and `.metadata.json` file. The
metadata records the OpenChrome version, source commit, target triple, Bun
version, byte size, and SHA-256 digest.

## macOS or Linux

Pin the release version. Do not download from a moving `latest` URL in host
configuration or automation.

```bash
VERSION=1.13.0 # Example: choose a release that lists standalone assets.
ASSET=openchrome-macos-arm64 # or openchrome-macos-x64 / openchrome-linux-x64
BASE="https://github.com/shaun0927/openchrome/releases/download/v${VERSION}"

curl -fL "${BASE}/${ASSET}" -o openchrome
curl -fL "${BASE}/${ASSET}.sha256" -o "${ASSET}.sha256"
chmod +x openchrome

# The checksum file names the release asset, so verify from a temporary copy.
cp openchrome "${ASSET}"
shasum -a 256 -c "${ASSET}.sha256"  # Linux may use: sha256sum -c
rm "${ASSET}"

./openchrome --version
./openchrome build-info
./openchrome config --client codex
```

If the chosen release does not contain the named asset, use the npm package for
that host instead of downloading an artifact from another version.

## Windows PowerShell

```powershell
$Version = "1.13.0" # Example: choose a release that lists standalone assets.
$Asset = "openchrome-windows-x64.exe"
$Base = "https://github.com/shaun0927/openchrome/releases/download/v$Version"

Invoke-WebRequest "$Base/$Asset" -OutFile $Asset
Invoke-WebRequest "$Base/$Asset.sha256" -OutFile "$Asset.sha256"

$Expected = (Get-Content "$Asset.sha256").Split(" ")[0].ToLowerInvariant()
$Actual = (Get-FileHash $Asset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw "OpenChrome checksum mismatch" }

.\openchrome-windows-x64.exe --version
.\openchrome-windows-x64.exe build-info
.\openchrome-windows-x64.exe config --client codex
```

## MCP configuration

Use the absolute verified executable path in MCP host configuration:

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "/absolute/path/to/openchrome",
      "args": ["serve", "--auto-launch", "--minimal"]
    }
  }
}
```

The release workflow certifies command help, config output, full/minimal tool
manifests, and an MCP `initialize` plus `tools/list` handshake with `PATH`
cleared. On macOS arm64 and Linux x64 it also runs `doctor`, navigates to a
controlled local fixture in the Chrome build pinned by the repository's
Puppeteer runtime, reads the page back through MCP, and verifies managed Chrome
shutdown. These checks prove the executable does not locate Node.js at runtime;
normal browser calls still require a supported Chrome or Chromium installation.
