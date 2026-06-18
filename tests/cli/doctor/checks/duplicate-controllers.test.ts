import { checkDuplicateControllers } from '../../../../src/cli/doctor/checks/duplicate-controllers';
import { withPrescriptiveFields } from '../../../../src/cli/doctor';
import {
  getCurrentControllerTopology,
  summarizeDuplicateControllerDiagnostics,
} from '../../../../src/utils/duplicate-controller-diagnostics';

jest.mock('../../../../src/utils/duplicate-controller-diagnostics', () => ({
  getCurrentControllerTopology: jest.fn(),
  summarizeDuplicateControllerDiagnostics: jest.fn(),
}));

const mockSummarize = summarizeDuplicateControllerDiagnostics as jest.MockedFunction<typeof summarizeDuplicateControllerDiagnostics>;
const mockTopology = getCurrentControllerTopology as jest.MockedFunction<typeof getCurrentControllerTopology>;

describe('duplicate controller doctor check', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockSummarize.mockReturnValue({
      processes: [],
      duplicateGroups: [],
      configs: [],
      mixedInstallations: false,
      warnings: [],
      remediation: [
        'Keep exactly one direct OpenChrome owner per Chrome port/profile.',
        'For coordinated sharing, route clients through --broker/--connect-broker or --auto-elect when that topology is explicitly enabled.',
      ],
    });
    mockTopology.mockReturnValue({
      role: 'unlocked',
      port: 9222,
      userDataDir: '/tmp/openchrome-profile',
      lockPath: '/tmp/openchrome-lock.json',
    });
  });

  test('warns with facts when configured port/profile is owned by another OpenChrome process', async () => {
    mockTopology.mockReturnValue({
      role: 'unknown',
      port: 47777,
      userDataDir: '/tmp/openchrome-live-profile',
      lockPath: '/tmp/openchrome-live-profile.lock',
      ownerPid: 12345,
    });

    const result = withPrescriptiveFields(await checkDuplicateControllers());

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('already owned by OpenChrome PID 12345');
    expect(result.reason).toContain('already owned');
    expect(result.next_action).toContain('one direct OpenChrome owner');
    expect(result.safe_alternatives?.slice(0, 2).join('\n')).toContain('--allow-unsafe-shared-attach');
    expect(result.facts).toEqual(expect.objectContaining({
      runtime_topology: 'blocked-by-owner',
      port: 47777,
      userDataDir: '/tmp/openchrome-live-profile',
      lockPath: '/tmp/openchrome-live-profile.lock',
      ownerPid: 12345,
    }));
  });
});
