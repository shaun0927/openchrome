import {
  activeFamilies,
  bootstrapPilot,
  isContractRuntimeEnabled,
  isHandoffPersistEnabled,
  isPerceptionVotingEnabled,
  isPilotEnabled,
  isSkillCuratorEnabled,
  isStateGraphEnabled,
  isTraceEnabled,
  isTruthy,
  logActiveFlags,
  resetFlagsCache,
} from '../../../src/harness/flags';

describe('harness/flags', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    resetFlagsCache();
    process.argv = ['node', 'cli/index.js'];
    process.env = { ...originalEnv };
    delete process.env.OPENCHROME_PILOT;
    delete process.env.OPENCHROME_TRACE;
    delete process.env.OPENCHROME_STATE_GRAPH;
    delete process.env.OPENCHROME_CONTRACT_RUNTIME;
    delete process.env.OPENCHROME_HANDOFF_PERSIST;
    delete process.env.OPENCHROME_PERCEPTION_VOTING;
    delete process.env.OPENCHROME_SKILL_CURATOR;
  });

  afterAll(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    resetFlagsCache();
  });

  describe('isTruthy', () => {
    test.each([
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      ['on', true],
      ['  YES  ', true],
      ['0', false],
      ['false', false],
      ['no', false],
      ['off', false],
      ['', false],
      ['nope', false],
      [undefined, false],
    ])('isTruthy(%j) -> %j', (input, expected) => {
      expect(isTruthy(input as string | undefined)).toBe(expected);
    });
  });

  describe('isPilotEnabled', () => {
    test('default (no flag, no env) -> false', () => {
      expect(isPilotEnabled()).toBe(false);
    });

    test('--pilot in argv -> true', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      resetFlagsCache();
      expect(isPilotEnabled()).toBe(true);
    });

    test('--pilot=1 in argv -> true', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot=1'];
      resetFlagsCache();
      expect(isPilotEnabled()).toBe(true);
    });

    test('--pilot=false in argv -> false', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot=false'];
      resetFlagsCache();
      expect(isPilotEnabled()).toBe(false);
    });

    test('OPENCHROME_PILOT=1 -> true', () => {
      process.env.OPENCHROME_PILOT = '1';
      resetFlagsCache();
      expect(isPilotEnabled()).toBe(true);
    });

    test('OPENCHROME_PILOT=0 -> false', () => {
      process.env.OPENCHROME_PILOT = '0';
      resetFlagsCache();
      expect(isPilotEnabled()).toBe(false);
    });

    test('result is cached', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      resetFlagsCache();
      const first = isPilotEnabled();
      process.argv = ['node', 'cli/index.js', 'serve'];
      // No resetFlagsCache here; cache should retain the previous decision.
      expect(isPilotEnabled()).toBe(first);
    });
  });

  describe('per-family flags', () => {
    test('all return false when pilot is off', () => {
      expect(isTraceEnabled()).toBe(false);
      expect(isStateGraphEnabled()).toBe(false);
      expect(isContractRuntimeEnabled()).toBe(false);
      expect(isHandoffPersistEnabled()).toBe(false);
      expect(isPerceptionVotingEnabled()).toBe(false);
      expect(isSkillCuratorEnabled()).toBe(false);
    });

    test('all default to true when pilot is on', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      resetFlagsCache();
      expect(isTraceEnabled()).toBe(true);
      expect(isStateGraphEnabled()).toBe(true);
      expect(isContractRuntimeEnabled()).toBe(true);
      expect(isHandoffPersistEnabled()).toBe(true);
      expect(isPerceptionVotingEnabled()).toBe(true);
      expect(isSkillCuratorEnabled()).toBe(true);
    });

    test('explicit env=0 turns one family off without affecting others', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      process.env.OPENCHROME_TRACE = '0';
      resetFlagsCache();
      expect(isTraceEnabled()).toBe(false);
      expect(isStateGraphEnabled()).toBe(true);
    });

    test('empty string env is treated as unset (defaults to true under pilot)', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      process.env.OPENCHROME_TRACE = '';
      resetFlagsCache();
      expect(isTraceEnabled()).toBe(true);
    });
  });

  describe('activeFamilies', () => {
    test('empty when pilot is off', () => {
      expect(activeFamilies()).toEqual([]);
    });

    test('full list when pilot is on with no overrides', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      resetFlagsCache();
      expect(activeFamilies()).toEqual([
        'trace',
        'state_graph',
        'contract_runtime',
        'handoff_persist',
        'perception_voting',
        'skill_curator',
        'react_pilot',
      ]);
    });

    test('respects per-family overrides', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      process.env.OPENCHROME_TRACE = '0';
      process.env.OPENCHROME_PERCEPTION_VOTING = 'false';
      resetFlagsCache();
      expect(activeFamilies()).toEqual([
        'state_graph',
        'contract_runtime',
        'handoff_persist',
        'skill_curator',
        'react_pilot',
      ]);
    });
  });

  describe('logActiveFlags', () => {
    let stderrChunks: string[];
    let writeSpy: jest.SpyInstance;

    beforeEach(() => {
      stderrChunks = [];
      writeSpy = jest
        .spyOn(process.stderr, 'write')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(((chunk: any) => {
          stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        }) as never);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    test('writes core-only line to stderr when pilot is off', () => {
      logActiveFlags();
      expect(stderrChunks).toEqual(['[harness] core only (--pilot not set)\n']);
    });

    test('writes core+pilot line with active families', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      resetFlagsCache();
      logActiveFlags();
      expect(stderrChunks).toHaveLength(1);
      expect(stderrChunks[0]).toMatch(
        /^\[harness\] core\+pilot enabled \(trace,state_graph,contract_runtime,handoff_persist,perception_voting,skill_curator,react_pilot\)\n$/,
      );
    });

    test('writes "no families active" when pilot is on but every family is overridden off', () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      process.env.OPENCHROME_TRACE = '0';
      process.env.OPENCHROME_STATE_GRAPH = '0';
      process.env.OPENCHROME_CONTRACT_RUNTIME = '0';
      process.env.OPENCHROME_HANDOFF_PERSIST = '0';
      process.env.OPENCHROME_PERCEPTION_VOTING = '0';
      process.env.OPENCHROME_SKILL_CURATOR = '0';
      process.env.OPENCHROME_REACT_PILOT = '0';
      resetFlagsCache();
      logActiveFlags();
      expect(stderrChunks).toEqual(['[harness] core+pilot enabled (no families active)\n']);
    });
  });

  describe('bootstrapPilot', () => {
    test('returns null when pilot is off and does not load src/pilot/**', async () => {
      const result = await bootstrapPilot();
      expect(result).toBeNull();
    });

    test('returns the pilot module when pilot is on', async () => {
      process.argv = ['node', 'cli/index.js', 'serve', '--pilot'];
      resetFlagsCache();
      const result = await bootstrapPilot();
      // src/pilot/index.ts currently re-exports nothing; the imported module
      // object exists but has no own keys. That is the contract for the
      // 1.11 cleanup until pilot families land.
      expect(result).not.toBeNull();
      expect(typeof result).toBe('object');
    });
  });
});
