const base = require('./jest.e2e.config');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/tests/e2e/scenarios/marathon.e2e.ts'],
  testTimeout: 3_900_000,
};
