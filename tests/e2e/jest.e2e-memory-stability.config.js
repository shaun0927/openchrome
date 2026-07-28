const base = require('./jest.e2e.config');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/tests/e2e/scenarios/memory-stability.e2e.ts'],
  testTimeout: 2_100_000,
};
