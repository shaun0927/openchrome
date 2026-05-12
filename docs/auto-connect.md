# `--auto-connect` (DevToolsActivePort)

`openchrome serve --auto-connect` attaches to a Chrome instance you started
yourself by reading `<userDataDir>/DevToolsActivePort` — Chrome's stable,
documented record of the active remote-debugging port.

This eliminates the manual port hand-off that the `--attach` /
`--remote-debugging-port` workflow requires.

## Quick start

1. Launch Chrome yourself with `--remote-debugging-port=0` (let Chrome pick a
   free port) and a known `--user-data-dir`.
2. Authorise the connection once at `chrome://inspect/#remote-debugging` (only
   required on Chrome 144+ when the user-data dir is the OS default).
3. Start openchrome with `--auto-connect=<userDataDir>` (or pass no path to
   use the platform default for the channel).

```bash
# 1. Start Chrome
google-chrome \
  --remote-debugging-port=0 \
  --user-data-dir=/tmp/oc-attach-demo \
  https://example.com &

# 2. Wait until DevToolsActivePort exists (≈ 1 s on cold start)

# 3. Start openchrome — no --port needed
openchrome serve --auto-connect=/tmp/oc-attach-demo
```

The discovered port and the resolved user-data dir are exposed via
`mcp__openchrome__oc_get_connection_info` with `host="openchrome"`:

```json
{
  "mode": "auto-connect",
  "userDataDir": "/tmp/oc-attach-demo",
  "port": 53187,
  "wsEndpoint": "ws://127.0.0.1:53187/devtools/browser/<uuid>",
  "attachedAt": "2026-05-12T12:34:56.789Z"
}
```

## Environment variable

`OPENCHROME_AUTO_CONNECT=<userDataDir>` mirrors the CLI flag. An empty value
behaves the same as `--auto-connect` with no path — openchrome falls back to
the platform default for `--channel` (defaults to `stable`).

## Default user-data dirs per platform

When you pass `--auto-connect` without a path, openchrome uses the following
defaults (assumes Chrome stable channel):

| Platform | Default user-data dir |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| Linux | `~/.config/google-chrome` |

For other channels:

| Channel | macOS / Windows variant | Linux variant |
|---|---|---|
| `beta` | `Chrome Beta` | `~/.config/google-chrome-beta` |
| `dev` | `Chrome Dev` | `~/.config/google-chrome-unstable` |
| `canary` | `Chrome Canary` (no Linux build) | n/a |

If you use a different browser variant (Chromium, Brave, Edge, Arc, ...),
pass the path explicitly:

```bash
openchrome serve --auto-connect=/path/to/your/user-data-dir
```

## Mutual-exclusion with `--launch-mode`

`--auto-connect` implies `--launch-mode=attach`. Combining it with the spawn
modes is a startup error:

| `--auto-connect` | `--launch-mode` | Outcome |
|---|---|---|
| set | unset | Allowed (attach is implicit) |
| set | `attach` | Allowed (no-op duplication) |
| set | `auto` | **Refused at startup** (non-zero exit) |
| set | `isolated` | **Refused at startup** (non-zero exit) |
| unset | any | Existing behaviour preserved |

The error message names both inputs and tells you which one to drop:

```
[openchrome] --auto-connect (/tmp/oc-attach-demo) is incompatible with
--launch-mode=isolated (from cli). Auto-connect attaches to a Chrome you
launched yourself; 'auto' and 'isolated' modes spawn a new Chrome.
Drop --auto-connect, switch --launch-mode=attach, or unset the conflicting
source.
```

## Refused: openchrome's managed profile

openchrome owns `~/.openchrome/profile/`. Auto-connecting to it would cross
the launch / attach lifecycle boundary, so we refuse loudly:

```
[openchrome] --auto-connect failed: Refusing to auto-connect to openchrome's
managed profile (/Users/you/.openchrome/profile). That profile is owned by
openchrome and is only valid in launch mode.
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `DevToolsActivePort not found at <path> after 5000ms` | Chrome not running with that user-data dir, or still starting | Start Chrome first; raise the timeout if your machine is slow |
| `port not bound` | File present but Chrome already exited | Re-launch Chrome |
| `stale_active_port_file` (file > 60 s, port closed) | Chrome shut down without cleaning up | Delete `DevToolsActivePort` and restart Chrome |
| `Refusing to auto-connect to openchrome's managed profile` | Pointed `--auto-connect` at `~/.openchrome/profile/` | Use a different user-data dir |

## Lifecycle guarantee

`--auto-connect` always sets the lifecycle mode to `attach` (#661). openchrome
will **not** kill the Chrome it attached to during shutdown — your existing
window survives `oc_stop`, SIGTERM, and process-exit handlers.
