import {
  defaultAssertContract,
  defaultResolveCurrentTab,
  defaultRunStep,
} from '../../../src/pilot/dynamic-skills/attachment-defaults';
import type { SkillRecord } from '../../../src/core/skill-memory/types';

const mockSessionManager = {
  getSessionTargetIds: jest.fn(),
  getTargetWorkerId: jest.fn(),
  getPage: jest.fn(),
};

jest.mock('../../../src/session-manager', () => ({
  getSessionManager: () => mockSessionManager,
}));

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    skillId: 'skill-1',
    domain: 'example.com',
    name: 'login',
    steps: [],
    contractId: 'ctr_login_success',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
    ...overrides,
  };
}

describe('dynamic-skills attachment defaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('defaultResolveCurrentTab selects the latest target across session workers', async () => {
    mockSessionManager.getSessionTargetIds.mockReturnValue(['old-tab', 'current-tab']);
    mockSessionManager.getTargetWorkerId.mockReturnValue('worker-2');
    mockSessionManager.getPage.mockResolvedValue({ url: () => 'https://example.com/account' });

    const out = await defaultResolveCurrentTab('session-1');

    expect(out).toEqual({
      tabId: 'current-tab',
      workerId: 'worker-2',
      url: 'https://example.com/account',
    });
    expect(mockSessionManager.getPage).toHaveBeenCalledWith(
      'session-1',
      'current-tab',
      'worker-2',
      'dynamic-skills-replay',
    );
  });

  test('defaultRunStep resolves the page through the tab owner worker', async () => {
    const page = {
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
    };
    mockSessionManager.getPage.mockResolvedValue(page);

    const out = await defaultRunStep(
      { tabId: 'tab-1', workerId: 'worker-2', url: 'https://example.com/' },
      { kind: 'click', selector: '#submit' },
      {},
      'session-1',
    );

    expect(out).toEqual({ ok: true });
    expect(mockSessionManager.getPage).toHaveBeenCalledWith(
      'session-1',
      'tab-1',
      'worker-2',
      'dynamic-skills-replay',
    );
  });

  test('defaultAssertContract fails closed when an opaque contract_id is unresolved', async () => {
    const cdp = {
      send: jest.fn().mockResolvedValue({
        result: { value: { __openchrome_contract_missing: true } },
      }),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    const page = {
      target: () => ({ createCDPSession: async () => cdp }),
    };
    mockSessionManager.getPage.mockResolvedValue(page);

    const out = await defaultAssertContract(
      makeSkill({ contractId: 'ctr_login_success' }),
      { tabId: 'tab-1', workerId: 'worker-2', url: 'https://example.com/' },
      'session-1',
    );

    expect(out.pass).toBe(false);
    expect(out.reason).toBe('contract_not_found: contract_id:ctr_login_success');
    expect(mockSessionManager.getPage).toHaveBeenCalledWith(
      'session-1',
      'tab-1',
      'worker-2',
      'dynamic-skills-assert',
    );
  });
});
