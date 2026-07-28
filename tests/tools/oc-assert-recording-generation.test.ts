/// <reference types="jest" />

const mockEvaluate = jest.fn();
const mockGetActiveActionRecording = jest.fn();

jest.mock('../../src/contracts/evaluate', () => ({
  evaluate: mockEvaluate,
}));

jest.mock('../../src/recording/action-recorder', () => ({
  getActiveActionRecording: mockGetActiveActionRecording,
}));

import { registerOcAssertTool } from '../../src/tools/oc-assert';
import type { MCPResult, ToolHandler } from '../../src/types/mcp';

function loadHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  registerOcAssertTool({
    registerTool: (_name: string, registered: ToolHandler) => {
      handler = registered;
    },
  } as any);
  if (!handler) throw new Error('oc_assert handler not registered');
  return handler;
}

describe('oc_assert recording generation fence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('appends the verdict only through the recording captured at handler dispatch', async () => {
    let markEvaluationStarted!: () => void;
    let releaseEvaluation!: () => void;
    const evaluationStarted = new Promise<void>((resolve) => { markEvaluationStarted = resolve; });
    const evaluationGate = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
    const appendOld = jest.fn().mockResolvedValue(undefined);
    const appendReplacement = jest.fn().mockResolvedValue(undefined);
    mockGetActiveActionRecording.mockReturnValue({
      recorder: { appendContractResultForRecording: appendOld },
      recordingId: 'rec-old',
    });
    mockEvaluate.mockImplementation(async () => {
      markEvaluationStarted();
      await evaluationGate;
      return {
        passed: true,
        evidence: {
          passed: true,
          assertion_kind: 'url',
          details: { url: 'https://example.com' },
        },
      };
    });
    const handler = loadHandler();

    const pending = handler('session-a', {
      contract: { kind: 'url', pattern: 'example\\.com' },
      evidence: { snapshot: { url: 'https://example.com' } },
    });
    await evaluationStarted;
    mockGetActiveActionRecording.mockReturnValue({
      recorder: { appendContractResultForRecording: appendReplacement },
      recordingId: 'rec-replacement',
    });
    releaseEvaluation();

    const result = await pending as MCPResult;

    expect(result.isError).not.toBe(true);
    expect(mockGetActiveActionRecording).toHaveBeenCalledTimes(1);
    expect(appendOld).toHaveBeenCalledWith(
      'rec-old',
      expect.objectContaining({ verdict: 'pass' }),
    );
    expect(appendReplacement).not.toHaveBeenCalled();
  });
});
