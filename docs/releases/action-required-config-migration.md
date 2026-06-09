# Release-note block: MCP host config migration

Use this block in a release note when a new OpenChrome topology, flag, or setup
preset must be activated in existing MCP host configs.

## Action required for existing MCP host registrations

Updating OpenChrome installs the new capability, but it does **not** rewrite MCP
server entries that are already registered in Claude Code, Codex CLI, OpenCode,
or other hosts. Existing entries continue to run the old command and arguments
until you change that host's config.

If this release recommends a new topology for parallel sessions, do all three
steps:

```bash
npm install -g openchrome-mcp@latest
openchrome setup --client <claude|codex|opencode> <recommended-topology-flags>
# restart that MCP host session
```

For manual configs, update the existing `openchrome` MCP server entry with the
recommended `serve` arguments instead of adding a second direct `serve
--auto-launch` entry for the same Chrome port/profile.

Restart is required because most MCP hosts load tool namespaces during session
startup. A running Claude Code, Codex CLI, OpenCode, or IDE session should not be
expected to hot-reload changed MCP server arguments.

Do not use npm `postinstall` hooks or package updates to silently mutate host
configs; users should opt into config migration through `openchrome setup` or an
explicit manual edit.
