/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    'extension/src/**/*.ts',
    'cli/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 75,
      lines: 75,
      statements: 75,
    },
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000,
  // Bound worker count and per-worker memory so a full local run cannot
  // exhaust RAM. This suite is large (~600 suites) and ts-jest holds a TS
  // program per worker; on many-core machines the default (cores - 1)
  // workers spike to multiple GB. '50%' keeps parallelism reasonable, and
  // workerIdleMemoryLimit restarts any worker that grows past the cap
  // (also mitigates leaky test teardowns). CI runners are small-core, so
  // these caps are effectively no-ops there.
  maxWorkers: '50%',
  workerIdleMemoryLimit: '512MB',
  verbose: true,
};
