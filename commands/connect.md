---
description: >
  Connect to OpenChrome and confirm the MCP server is reachable. Runs a quick
  health check, reports the Chrome CDP status, and prints the tool surface summary.
---

# /openchrome:connect

Check that OpenChrome is installed, the MCP server is running, and Chrome is
reachable. Then print a one-line summary of the available tool surface.

## Steps

1. Call `oc_connection_health` to verify the CDP connection and server version.
2. If `status` is `"ok"`, respond: "OpenChrome is connected — Chrome is live on
   `<cdp_url>`. Server v`<version>` · `<tool_count>` tools available."
3. If `status` is not `"ok"`, report the error message verbatim and suggest
   running `openchrome doctor` in a terminal to diagnose.

## Example output

```
OpenChrome is connected — Chrome is live on ws://127.0.0.1:9222.
Server v1.12.5 · 110 tools available.
```

## Arguments

`$ARGUMENTS` — ignored; this command takes no arguments.
