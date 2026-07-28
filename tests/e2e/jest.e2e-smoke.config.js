const base = require('./jest.e2e.config');

module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/tests/e2e/scenarios/http-independence.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/kill-recovery.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/parallel-burst.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/prometheus-metrics.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/tab-isolation.e2e.ts',
  ],
};
