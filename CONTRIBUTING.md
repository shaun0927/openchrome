# Contributing to OpenChrome

Thank you for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run tests: `npm test`

## Development Setup

### Prerequisites

- Node.js 18+
- Google Chrome

### Building

```bash
# Build everything
npm run build

# Build CLI only (with watch mode)
npm run dev

# Build source only
npm run build:src
```

### Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- session-manager.test.ts
```

### Local Testing

```bash
# Start MCP server locally
node dist/cli/index.js serve --auto-launch

# Run doctor check
node dist/cli/index.js doctor
```

## Code Style

- Use TypeScript for all code
- Follow existing code patterns
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused and small

## Commit Messages

Follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Formatting, missing semicolons, etc.
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding missing tests
- `chore`: Maintenance

Examples:
- `feat(session): add session timeout configuration`
- `fix(cdp): handle reconnection on detach`
- `docs(readme): update installation instructions`

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Add tests if applicable
4. Update documentation if needed
5. Ensure all tests pass: `npm test`
6. Submit a pull request

### PR Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Builds successfully (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] Commit messages follow convention

## Architecture Overview

```
src/
├── mcp-server.ts          # MCP protocol server (stdio JSON-RPC)
├── session-manager.ts     # Browser session lifecycle
├── index.ts               # Main entry point
├── cdp/                   # Chrome DevTools Protocol layer
│   ├── client.ts          # CDP client wrapper
│   └── connection-pool.ts # Connection pooling
├── chrome/                # Chrome process management
│   ├── launcher.ts        # Auto-launch Chrome with debugging port
│   └── pool.ts            # Browser context pool
├── tools/                 # MCP tool implementations (36 tools)
│   ├── index.ts           # Tool registration
│   ├── navigation.ts      # navigate, page_reload
│   ├── computer.ts        # screenshot, click, keyboard, scroll
│   ├── read-page.ts       # Accessibility tree parsing
│   ├── find.ts            # Natural language element search
│   ├── form.ts            # form_input, fill_form
│   ├── orchestration.ts   # workflow_init, worker_create, etc.
│   └── ...                # Other tool modules
├── orchestration/         # Parallel workflow engine
├── hints/                 # Adaptive Guidance system
│   ├── hint-engine.ts     # Rule evaluation engine
│   └── rules/             # Error recovery, sequence detection, etc.
├── dashboard/             # Terminal dashboard (optional)
├── resources/             # MCP resources (usage guide)
├── config/                # Global configuration
├── types/                 # TypeScript type definitions
└── utils/                 # Shared utilities

cli/
├── index.ts               # CLI entry point (setup, serve, doctor, etc.)
└── update-check.ts        # Version update checker
```

### Key Concepts

1. **CDP-based**: Connects to Chrome via Chrome DevTools Protocol (port 9222)
2. **Session Isolation**: Each Worker gets an isolated browser context (separate cookies, localStorage)
3. **MCP Protocol**: Communicates with Claude Code via JSON-RPC over stdio
4. **Adaptive Guidance**: Hint engine injects `_hint` fields into tool responses to prevent LLM mistakes
5. **Parallel Workflows**: Orchestration engine manages multiple Workers for concurrent tasks

## Testing Guidelines

### Unit Tests

- Test individual functions and classes
- Mock CDP connections and Chrome APIs
- Focus on business logic

### Integration Tests

- Test component interactions (e.g., multi-worker workflows)
- Use realistic scenarios
- Verify error handling and recovery

### Stress Tests

- Concurrent operations and race conditions
- Large data handling
- Error recovery under load

## Contribution Areas

Looking for something to work on? Here are the key areas where contributions would make the biggest impact.

### Multi-Client Compatibility

OpenChrome is a standard MCP server, but currently only tested with Claude Code. Help us verify and support other MCP clients.
Codex CLI now has a dedicated setup/config preset, but runtime validation is still needed across real environments.

| Client | Status | What's Needed |
|--------|--------|---------------|
| Claude Code | Verified | - |
| Cursor | Untested | Test all 36 tools, verify `instructions` field |
| Windsurf | Untested | Test all 36 tools, verify `instructions` field |
| Codex CLI | Preset added, runtime validation needed | Verify `initialize`, `tools/list`, and at least one browser-backed tool call using the documented Codex config |
| VS Code + MCP | Untested | Test basic tool flow |

**How to contribute**: Pick a client, run the test suite against it, report what works and what doesn't. Adapt `oc setup` to support the client if needed.

### Cross-Platform Support

Currently developed and tested on macOS. Windows and Linux need attention.

- **Windows**: Chrome path detection, `--remote-debugging-port` launch, named pipes vs Unix sockets
- **Linux**: Headless Chrome in CI environments, Wayland vs X11 screenshot handling
- **CI/CD**: GitHub Actions workflow for automated testing across platforms

### Performance Benchmarks

The README claims 80x speedup, but we need reproducible benchmarks.

- **Benchmark suite**: Automated comparison vs Playwright MCP on standard tasks (navigate, screenshot, form fill)
- **Memory profiling**: Measure actual memory usage with 5, 10, 20 Workers
- **Latency analysis**: Tool-by-tool latency comparison with other MCP browser tools

### Browser Support

Currently Chrome-only via CDP. Other browsers have similar protocols.

- **Edge**: Shares CDP — should work with minimal changes (needs testing)
- **Firefox**: Uses its own remote debugging protocol (significant work)
- **Safari**: Limited Web Inspector protocol (research needed)

### Adaptive Guidance Improvements

The hint engine (`src/hints/`) currently has 21 static rules. Areas to improve:

- **More error patterns**: Catalog common LLM mistakes and add recovery hints
- **Client-specific hints**: Different LLMs make different mistakes — adapt hints per client
- **Learned pattern sharing**: Export/import learned patterns across users
- **Benchmark hint effectiveness**: Measure how hints reduce retry loops and wasted tokens

### Tool Enhancements

- **Accessibility testing**: Tools for WCAG compliance checking
- **Visual regression**: Screenshot diff between runs
- **Network HAR export**: Export full network traffic as HAR files
- **Video recording**: Record browser session as video/GIF
- **Multi-tab orchestration**: Coordinate actions across tabs within a single Worker

### Developer Experience

- **`oc setup` for other clients**: Auto-configure for Cursor, Windsurf, etc.
- **`oc benchmark`**: Built-in benchmark command
- **`oc replay`**: Replay a recorded session for debugging
- **Plugin system**: Allow users to register custom tools

### Documentation

- **API reference**: Auto-generated docs for all 36 tools with examples
- **Tutorials**: Step-by-step guides (e.g., "Automate your CI dashboard")
- **Troubleshooting guide**: Common issues and solutions per platform

## Contribution Principles

### Adapter first, fork last

Before you patch `src/` core files to wire in a new backend (a new stealth
engine, a new extraction library, a new vision model, a new captcha solver),
try to land the integration as an **adapter** behind an existing extension
point. Adapters keep the core surface small, isolate third-party licence and
release cadence risk, and let the core CI stay green when the vendor changes
its API.

Fork the core (edit files under `src/actions/`, `src/cdp/`, `src/chrome/`
etc.) only when the adapter surface genuinely cannot express what you need.
When in doubt, open an issue describing the extension point you wish existed
before writing the fork.

#### Existing extension points

| Extension point | Where | Add a new backend by |
|---|---|---|
| Stealth injection scripts | `src/stealth/fingerprint-defense.ts`, `human-behavior.ts` | Adding a named script generator that returns a self-contained closure and wiring it into the stealth registry. |
| Captcha providers | `src/captcha/providers/` | Implementing the provider interface (detect + solve) and registering it in `solver-registry.ts`. |
| Extraction strategies | `src/extraction/strategies.ts` | Adding a strategy that consumes the shared `ExtractionRequest` and returns a `ExtractionResult`. |
| Vision grounding | `src/vision/` | Implementing the grounding tier interface and adding a fallback rung in the tier chain. |
| Auth backends | `src/auth/credential-store.ts` | Implementing the credential store interface (get/set/list) against a new backend (OS keychain, KMS, HashiCorp Vault). |
| Recovery hooks | `src/recovery/` | Adding a `RecoveryTrajectoryLedger` consumer that reads outcomes and emits corrective actions. |
| Hint rules | `src/hints/rules/` | Following the existing rule shape (match + response) and registering the rule. |
| MCP tools | `src/tools/` + `src/tools/index.ts` | Implementing the tool contract and registering it in the tool index. |

#### Adapter contract

Every adapter should:

1. **Declare its scope** — one exported interface that names what the adapter
   does. Do not re-export third-party types; wrap them so vendor breakage does
   not become a `src/` breakage.
2. **Be self-contained** — no imports from other adapter directories. Two
   adapters must never call each other; they meet only at the interface the
   core defines.
3. **Fail closed** — throw a typed error (e.g. `ExtractionError`,
   `StealthUnavailableError`) rather than a generic `Error`. The core routes
   typed errors into the failure classifier (`src/failure/classifier.ts`).
4. **Ship its own tests** — under `tests/<domain>/<adapter-name>/`. If the
   adapter cannot be tested without hitting the network or spawning Chrome,
   add a mock/fake sibling that satisfies the interface for integration tests.
5. **License-tag the origin** — if the adapter mirrors an idiom from an
   upstream open-source project, note the project name, licence, and source
   file at the top of the adapter module (see
   `src/chrome/auto-connect.ts` for the pattern openchrome uses today).

#### Example: adding a new extraction backend

Suppose you want to add [trafilatura](https://github.com/adbar/trafilatura)
(Apache-2.0) as a body-text extractor. The adapter path avoids touching
`src/extraction/mode.ts` or `src/extraction/plan.ts`:

```ts
// src/extraction/strategies/trafilatura.ts
import type { ExtractionRequest, ExtractionResult, ExtractionStrategy } from '../types';

/**
 * trafilatura-backed extractor. Origin: adbar/trafilatura (Apache-2.0).
 * Runs the trafilatura CLI out-of-process so the vendor lifecycle stays
 * isolated from the Node.js core.
 */
export const trafilaturaStrategy: ExtractionStrategy = {
  name: 'trafilatura',
  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    // ... call trafilatura, wrap result, throw ExtractionError on failure.
  },
};
```

Then register the strategy in `src/extraction/strategies/index.ts` — one
line. No core file changes, no cross-adapter coupling, and if trafilatura
disappears tomorrow the strategy file is the only thing that needs replacing.

#### When forking core is the right call

Some changes cannot ship as adapters and legitimately need core patches:

- Fixing a bug in the CDP client, launcher, or session manager.
- Adding a new MCP protocol capability or resource.
- Adding a new lifecycle mode (attach / launch / auto) or launch guard.
- Refactoring a shared type or contract.

For those, open an issue that names the invariant you are changing before you
send the PR. Core changes go through a stricter review because they affect
every adapter downstream.

### Good First Issues

If you're new to the project, these are good starting points:

- Add a new hint rule to `src/hints/rules/` (follow existing patterns)
- Test OpenChrome on a non-Claude MCP client and report results
- Add Windows Chrome path detection in `src/chrome/launcher.ts`
- Write an example script using OpenChrome tools
- Improve error messages for common setup failures

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
