# tests/pilot/

Tests for modules under `src/pilot/**`.

Pilot-tier code is opt-in via `--pilot`. Tests here verify that the default
server still boots without pilot modules and that enabled pilot features do not
require outbound LLM APIs or third-party credentials.

## Running

```bash
npx jest tests/pilot
```
