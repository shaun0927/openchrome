const base = require('./jest.e2e.config');

module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/tests/e2e/scenarios/auth-persistence.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/browser-state-restore.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/compaction-resume.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/dashboard-e2e.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/event-loop-block.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/gc-resilience.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/idle-session.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/journal-handoff.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/kill-recovery.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/memory-pressure.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/multi-profile-errors.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/multi-profile.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/multi-site.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/network-disruption.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/network-intercept.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/repeated-tool-loop.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/server-restart.e2e.ts',
    '<rootDir>/tests/e2e/scenarios/tab-isolation.e2e.ts',
  ],
};
