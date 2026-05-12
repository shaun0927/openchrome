# openchrome agent preamble

`capability-map.md` is an auto-generated, drift-guarded summary of every MCP
tool exposed by openchrome. It is designed to be prepended to an agent's system
prompt so the agent knows what tools are available without calling `tools/list`.

## Loading the capability map with the Anthropic SDK

```typescript
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';

const capabilityMap = fs.readFileSync(
  path.join(__dirname, 'capability-map.md'),
  'utf8'
);

const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 4096,
  system: `You are a browser-automation agent with access to the openchrome MCP server.\n\n${capabilityMap}`,
  messages: [{ role: 'user', content: 'Navigate to https://example.com and return the page title.' }],
});
```

## Keeping the map up to date

The map is regenerated from the live tool registry:

```bash
npm run gen:capability-map
```

A CI workflow (`.github/workflows/capability-map.yml`) fails any PR that
modifies tool files without regenerating the map, preventing drift between
source and documentation.

## File constraints

- Maximum size: **6 144 bytes** (fits comfortably in a system-prompt slot).
- If params lines push the file over the limit, the generator automatically
  drops them and retains tool names + descriptions only.
- `expand_tools` is intentionally excluded — it is a server-injected
  progressive-disclosure hint, not a stable registered tool.
