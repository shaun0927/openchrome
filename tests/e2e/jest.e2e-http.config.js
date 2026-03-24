/** @type {import('jest').Config} */
const path = require('path');

/**
 * Jest config for HTTP-transport E2E tests (E2E-13 through E2E-18).
 * These tests are self-contained: each starts its own server via HttpMCPClient.
 * No global setup/teardown needed (unlike the stdio-based E2E tests).
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: path.resolve(__dirname, '../..'),
  testMatch: ['**/tests/e2e/scenarios/**/*.e2e.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    // Exclude stdio-based tests that need global setup
    'marathon', 'kill-recovery', 'server-restart', 'auth-persistence',
    'tab-isolation', 'memory-stability', 'memory-pressure', 'idle-session',
    'multi-site', 'gc-resilience', 'compaction-resume', 'endurance',
    'multi-profile', 'event-loop-block',
  ],
  testTimeout: 120_000,
  maxWorkers: 1,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  verbose: true,
};
