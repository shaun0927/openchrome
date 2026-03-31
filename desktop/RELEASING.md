# Desktop Release Process

This document describes how to release a new version of the OpenChrome desktop app. The desktop app is built with Tauri and produces signed, notarized installers for macOS, Windows, and Linux.

Desktop releases are **completely independent** from CLI (npm) releases. A CLI release does not trigger a desktop build, and vice versa. Each uses its own tag convention and versioning.

---

## Prerequisites

### Code Signing Certificates

Before your first release, ensure the following certificates and credentials are available:

**macOS**
- An Apple Developer account with a valid Developer ID Application certificate
- The certificate exported as a Base64-encoded `.p12` file
- An app-specific password for notarization (generated at appleid.apple.com)
- Your Apple Team ID (found in Apple Developer portal)

**Windows**
- A code signing certificate (EV or OV) exported as a Base64-encoded `.pfx` file
- The certificate password

### GitHub Secrets Setup

All secrets must be added to the repository under **Settings → Secrets and variables → Actions**. The CI workflow reads these at build time.

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID (10-character string) |
| `APPLE_PASSWORD` | App-specific password for notarization (not your Apple ID login password) |
| `WINDOWS_CERTIFICATE` | Base64-encoded `.pfx` Windows code signing certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.pfx` certificate |
| `TAURI_PRIVATE_KEY` | Private key for Tauri's auto-updater signature verification |
| `TAURI_KEY_PASSWORD` | Password for the Tauri private key |

To generate a Tauri key pair (if not already done):
```bash
npx tauri signer generate -w ~/.tauri/openchrome.key
```

Export the public key into your Tauri config (`tauri.conf.json → updater.pubkey`) and store the private key content as `TAURI_PRIVATE_KEY`.

---

## Tag Convention

Desktop releases use a separate tag prefix to distinguish them from CLI releases:

```
desktop-v{major}.{minor}.{patch}
```

Examples:
- `desktop-v1.0.0` — initial desktop release
- `desktop-v1.0.1` — patch release
- `desktop-v1.1.0` — minor release
- `desktop-v2.0.0` — major release

The version in `desktop/src-tauri/tauri.conf.json` (or `Cargo.toml`) must match the tag version. Update this file before tagging.

---

## Step-by-Step Release Process

### 1. Prepare the release

Update the desktop app version in `desktop/src-tauri/tauri.conf.json`:

```json
{
  "package": {
    "version": "1.0.0"
  }
}
```

Update `desktop/CHANGELOG.md` with the changes in this release. Commit these changes to `develop`:

```bash
git add desktop/src-tauri/tauri.conf.json desktop/CHANGELOG.md
git commit -m "chore: bump desktop version to 1.0.0"
git push origin develop
```

### 2. Tag the release

Create an annotated tag on the commit you want to release:

```bash
git tag -a desktop-v1.0.0 -m "Desktop release v1.0.0"
```

### 3. Push the tag

```bash
git push --tags
```

Pushing the tag triggers the CI workflow automatically.

### 4. CI builds all platforms (20–30 min)

The CI workflow builds the desktop app in parallel on three runners:
- **macOS** — produces `OpenChrome-1.0.0-arm64.dmg` (Apple Silicon) and `OpenChrome-1.0.0-x64.dmg` (Intel)
- **Windows** — produces `OpenChrome-1.0.0-x64-setup.exe`
- **Linux** — produces `OpenChrome-1.0.0-x86_64.AppImage`

### 5. CI signs and notarizes (5–10 min)

After building, CI:
- Signs the macOS `.dmg` files with the Developer ID Application certificate
- Submits the macOS builds to Apple for notarization and staples the ticket
- Signs the Windows `.exe` with the Windows certificate
- Signs all artifacts with the Tauri updater private key and generates `latest.json`

### 6. CI creates a GitHub Release

Once all platforms are signed, CI creates a GitHub Release tagged `desktop-v1.0.0` containing:

| Artifact | Platform |
|----------|----------|
| `OpenChrome-1.0.0-arm64.dmg` | macOS Apple Silicon |
| `OpenChrome-1.0.0-x64.dmg` | macOS Intel |
| `OpenChrome-1.0.0-x64-setup.exe` | Windows x64 |
| `OpenChrome-1.0.0-x86_64.AppImage` | Linux x86_64 |
| `latest.json` | Auto-updater manifest |
| CHANGELOG | Release notes |

### 7. Auto-updater picks up the new version

Existing desktop app installations will detect the new `latest.json` on next launch and prompt users to update. No manual intervention required.

---

## Verification Checklist

After the GitHub Release is created, verify the following:

- [ ] All four platform artifacts are attached to the release
- [ ] `latest.json` is present and contains the correct version and signatures
- [ ] macOS `.dmg` files open without a "damaged or can't be opened" warning (Gatekeeper check)
- [ ] macOS `.dmg` installer passes `spctl --assess --type open --context context:primary-signature` 
- [ ] Windows `.exe` shows publisher name in the UAC prompt (not "Unknown Publisher")
- [ ] Linux `.AppImage` is executable and launches correctly
- [ ] Auto-updater in a previous version detects the new release
- [ ] GitHub Release notes are accurate and link to the full CHANGELOG
- [ ] Release is marked as latest on GitHub (not pre-release), unless it is a pre-release

---

## Separation from CLI Releases

| | CLI (npm) | Desktop (Tauri) |
|---|---|---|
| **Tag prefix** | `v{major}.{minor}.{patch}` | `desktop-v{major}.{minor}.{patch}` |
| **Distribution** | npm registry (`openchrome-mcp`) | GitHub Releases |
| **Trigger** | Push tag matching `v*` | Push tag matching `desktop-v*` |
| **Versioning** | `package.json` | `desktop/src-tauri/tauri.conf.json` |
| **Versioning pace** | Independent | Independent |

CLI and desktop versions do not need to stay in sync. It is normal for the CLI to be at `v1.9.0` while the desktop is at `desktop-v1.0.0`.

---

## Hotfix Release Process

For urgent fixes that cannot wait for the next planned release:

1. Create a hotfix branch from the current release tag:
   ```bash
   git checkout -b hotfix/desktop-1.0.1 desktop-v1.0.0
   ```

2. Apply the fix, commit, and push the branch:
   ```bash
   git add <files>
   git commit -m "fix: <description>"
   git push origin hotfix/desktop-1.0.1
   ```

3. Tag and push the hotfix:
   ```bash
   git tag -a desktop-v1.0.1 -m "Desktop hotfix release v1.0.1"
   git push --tags
   ```

4. Merge the hotfix back into `develop`:
   ```bash
   git checkout develop
   git merge --no-ff hotfix/desktop-1.0.1
   git push origin develop
   ```

5. Delete the hotfix branch after merging:
   ```bash
   git branch -d hotfix/desktop-1.0.1
   git push origin --delete hotfix/desktop-1.0.1
   ```

---

## Troubleshooting

### macOS notarization fails

**Symptom:** CI reports `Apple's notarization service returned an error`.

**Common causes and fixes:**
- `APPLE_ID` or `APPLE_PASSWORD` (app-specific password) is wrong — regenerate the app-specific password at appleid.apple.com and update the secret.
- The certificate has expired — renew it in the Apple Developer portal and export a new `.p12`.
- The bundle ID in `tauri.conf.json` does not match what is registered in App Store Connect — ensure they match exactly.

### Windows signing fails

**Symptom:** CI reports certificate errors or the `.exe` shows "Unknown Publisher".

**Common causes and fixes:**
- `WINDOWS_CERTIFICATE` secret is not correctly Base64-encoded — re-encode with `base64 -w 0 certificate.pfx`.
- The certificate has expired — renew it with your certificate authority.
- The wrong certificate type was used — EV certificates require a hardware token and cannot be used in CI; use an OV certificate for automated signing.

### Linux AppImage does not launch

**Symptom:** Users report the AppImage crashes or shows a FUSE error.

**Common fix:** AppImages require FUSE 2. On modern Ubuntu/Fedora systems users may need to install `libfuse2`:
```bash
sudo apt install libfuse2   # Ubuntu 22.04+
```

Alternatively, users can extract the AppImage and run the binary directly:
```bash
./OpenChrome-1.0.0-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

### Auto-updater does not detect new version

**Symptom:** Existing installations do not prompt for the update.

**Common causes and fixes:**
- `latest.json` is missing from the GitHub Release — check the CI artifacts and attach it manually if needed.
- `TAURI_PRIVATE_KEY` or `TAURI_KEY_PASSWORD` is wrong — the signature in `latest.json` must match the public key in `tauri.conf.json`. Regenerate the key pair if they are mismatched.
- The updater endpoint URL in `tauri.conf.json` does not point to the correct GitHub Release URL.

### CI workflow does not trigger

**Symptom:** Pushing a `desktop-v*` tag does not start a workflow run.

**Fix:** Verify the workflow file in `.github/workflows/` has the correct tag filter:
```yaml
on:
  push:
    tags:
      - 'desktop-v*'
```
