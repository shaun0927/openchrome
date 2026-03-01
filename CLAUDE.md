# Claude Code Project Instructions

## PR Target Branch

All pull requests should target the `develop` branch. Release merges go from `develop` into `main`.

## Dependency Management

When modifying `package.json` (adding/removing/updating dependencies), you **MUST** run `npm install` afterwards to sync `package-lock.json`. Always commit both files together. Failing to do this breaks `npm ci` in CI and blocks all builds across every OS and Node version.

## Build & Test

```bash
npm install && npm run build && npm test
```

## Code Quality

- All source code, comments, commit messages, and PR descriptions must be in English
- Use `console.error()` for logging — `console.log()` writes to stdout which carries MCP JSON-RPC and will corrupt the protocol
- Use `os.homedir()` instead of `process.env.HOME` (Windows compatibility)
- Use `path.join()` for file paths instead of string concatenation
