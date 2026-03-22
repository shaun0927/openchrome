/** @type {import('jest').Config} */
const path = require('path');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: path.resolve(__dirname, '../..'),
  testMatch: ['**/tests/e2e/scenarios/**/*.e2e.ts'],
  testTimeout: 660_000,  // 11 minutes (accommodates TIME_SCALE=0.167)
  maxWorkers: 1,         // Sequential — shared Chrome instance
  globalSetup: '<rootDir>/tests/e2e/setup.ts',
  globalTeardown: '<rootDir>/tests/e2e/teardown.ts',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // DO NOT use setupFilesAfterSetup — the unit test setup.ts blocks real Chrome
  verbose: true,
};
