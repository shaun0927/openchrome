const base = require('./jest.e2e.config');

module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/tests/e2e/scenarios/disk-cleanup.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/http-independence.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/http-multi-client.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/parallel-burst.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/prometheus-metrics.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/rate-limiter.e2e.ts',
  ],
};
