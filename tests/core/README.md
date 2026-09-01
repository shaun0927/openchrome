# tests/core/

Tests for modules under `src/core/**`.

Core tests should pass for every source change. They also guard the boundary
that core modules do not load `src/pilot/**` unless the pilot tier is explicitly
enabled.

## Running

```bash
npx jest tests/core
```
