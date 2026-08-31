/** @type {import('jest').Config} */
const baseConfig = require('./jest.config');

module.exports = {
  ...baseConfig,
  testPathIgnorePatterns: [
    '/node_modules/',
    // Integration tests requiring Chrome/CDP connection
    'tests/chrome/launcher-port-race\\.test\\.ts',
    'tests/chrome/launcher-restart\\.test\\.ts',
    'tests/cdp/active-probe\\.test\\.ts',
    'tests/cdp/connect-coalescing\\.test\\.ts',
    'tests/cdp/connection-pool-src\\.test\\.ts',
    'tests/integration/hybrid-lightpanda\\.test\\.ts',
    'tests/session/manager-ttl\\.test\\.ts',
    'tests/tools/computer\\.test\\.ts',
    // Tests with environment-specific dependencies
    'tests/hints/hint-engine\\.test\\.ts',
    'tests/cli/update-check\\.test\\.ts',
  ],
  // CI logs are expensive for this suite: many passing tests intentionally
  // exercise diagnostic paths that write large console.error/console.log streams.
  // Keep failure assertions visible while suppressing passing-test chatter.
  verbose: false,
  silent: true,
  // Disable coverage thresholds in CI (subset of tests)
  coverageThreshold: undefined,
};
