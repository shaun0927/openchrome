# Contributing to Claude Chrome Parallel

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

| Client | Status | What's Needed |
|--------|--------|---------------|
| Claude Code | Verified | - |
| Cursor | Untested | Test all 36 tools, verify `instructions` field |
| Windsurf | Untested | Test all 36 tools, verify `instructions` field |
| Codex CLI | Untested | Test all 36 tools, verify `instructions` field |
| VS Code + MCP | Untested | Test basic tool flow |

**How to contribute**: Pick a client, run the test suite against it, report what works and what doesn't. Adapt `ccp setup` to support the client if needed.

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

- **`ccp setup` for other clients**: Auto-configure for Cursor, Windsurf, etc.
- **`ccp benchmark`**: Built-in benchmark command
- **`ccp replay`**: Replay a recorded session for debugging
- **Plugin system**: Allow users to register custom tools

### Documentation

- **API reference**: Auto-generated docs for all 36 tools with examples
- **Tutorials**: Step-by-step guides (e.g., "Automate your CI dashboard")
- **Troubleshooting guide**: Common issues and solutions per platform

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
