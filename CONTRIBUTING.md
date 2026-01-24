# Contributing to Claude Chrome Parallel

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

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
- A code editor (VS Code recommended)

### Building

```bash
# Build everything
npm run build

# Build extension only (with watch mode)
npm run dev

# Build CLI only
npm run build:cli
```

### Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- request-queue.test.ts
```

### Loading the Extension

1. Build the extension: `npm run build`
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `dist/extension` directory

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
5. Ensure all tests pass
6. Submit a pull request

### PR Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Builds successfully
- [ ] No linting errors
- [ ] Commit messages follow convention

## Architecture Overview

### Extension Structure

```
extension/
├── src/
│   ├── service-worker.ts    # Main background script
│   ├── session-manager.ts   # Session lifecycle management
│   ├── tab-group-manager.ts # Chrome tab group handling
│   ├── cdp-pool.ts          # CDP connection management
│   ├── request-queue.ts     # Per-session request queuing
│   ├── mcp-handler.ts       # MCP protocol handling
│   └── tools/               # MCP tool implementations
├── content/
│   └── content-script.ts    # Page-injected script
└── popup/
    └── popup.ts             # Extension popup UI
```

### Key Concepts

1. **Session Isolation**: Each Claude Code instance gets its own session with isolated resources
2. **Tab Groups**: Sessions are visually organized using Chrome tab groups
3. **Request Queuing**: Per-session FIFO queues prevent race conditions
4. **CDP Connections**: Each session maintains its own debugger connections

## Testing Guidelines

### Unit Tests

- Test individual functions and classes
- Mock Chrome APIs using the setup file
- Focus on business logic

### Integration Tests

- Test component interactions
- Use realistic scenarios
- Verify error handling

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
