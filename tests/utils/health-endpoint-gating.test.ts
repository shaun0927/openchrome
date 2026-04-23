/// <reference types="jest" />
import { resolveHealthEndpointEnabled } from '../../src/utils/health-endpoint-gating';

/**
 * Pure-function tests for the health-endpoint gating resolver (issue #648 §5.2).
 *
 * Table-driven coverage of every (transportMode, envOverride) combination
 * enumerated in the acceptance criteria. The resolver is used at the
 * HealthEndpoint construction site in `src/index.ts`; keeping the logic
 * pure means we do not have to spawn a child server to exercise it.
 */
describe('resolveHealthEndpointEnabled (issue #648)', () => {
  type Case = {
    label: string;
    transport: string;
    envOverride: string | undefined;
    expected: boolean;
  };

  const cases: Case[] = [
    { label: "stdio + unset → false",          transport: 'stdio', envOverride: undefined, expected: false },
    { label: "http + unset → true",            transport: 'http',  envOverride: undefined, expected: true  },
    { label: "both + unset → true",            transport: 'both',  envOverride: undefined, expected: true  },
    { label: "stdio + '1' → true",             transport: 'stdio', envOverride: '1',       expected: true  },
    { label: "stdio + 'true' → true",          transport: 'stdio', envOverride: 'true',    expected: true  },
    { label: "http + '0' → false",             transport: 'http',  envOverride: '0',       expected: false },
    { label: "http + 'false' → false",         transport: 'http',  envOverride: 'false',   expected: false },
    { label: "stdio + 'garbage' → false",      transport: 'stdio', envOverride: 'garbage', expected: false },
  ];

  test.each(cases)('$label', ({ transport, envOverride, expected }) => {
    expect(resolveHealthEndpointEnabled(transport, envOverride)).toBe(expected);
  });
});
