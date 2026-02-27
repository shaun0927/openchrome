/** @type {import('jest').Config} */
const baseConfig = require('./jest.config');

module.exports = {
  ...baseConfig,
  testPathIgnorePatterns: [
    '/node_modules/',
    // Integration tests requiring Chrome/CDP connection
    'tests/chrome/launcher-port-race\\.test\\.ts',
    'tests/chrome/launcher-restart\\.test\\.ts',
    'tests/src/cdp-active-probe\\.test\\.ts',
    'tests/src/cdp-connect-coalescing\\.test\\.ts',
    'tests/src/connection-pool\\.test\\.ts',
    'tests/src/hybrid-integration\\.test\\.ts',
    'tests/src/session-manager-ttl\\.test\\.ts',
    'tests/tools/computer\\.test\\.ts',
    // Tests with environment-specific dependencies
    'tests/hints/hint-engine\\.test\\.ts',
    'tests/cli/update-check\\.test\\.ts',
  ],
  // Disable coverage thresholds in CI (subset of tests)
  coverageThreshold: undefined,
};
