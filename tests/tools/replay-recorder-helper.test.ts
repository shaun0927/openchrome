/// <reference types="jest" />

describe('replay recorder helper', () => {
  test('capturePageReplayStep stages pre-resolved selectors for the current target', async () => {
    const captureReplayStep = jest.fn();
    jest.resetModules();
    jest.doMock('../../src/core/skill-memory', () => ({
      captureReplayStep,
    }));

    const { capturePageReplayStep } = await import('../../src/tools/_shared/replay-recorder');
    capturePageReplayStep({
      target: () => ({ _targetId: 'target-submit' }),
    }, {
      kind: 'click',
      selectors: [{ type: 'css', value: 'button[type="submit"]' }],
    });

    expect(captureReplayStep).toHaveBeenCalledWith('target-submit', {
      kind: 'click',
      selectors: [{ type: 'css', value: 'button[type="submit"]' }],
    });
  });

  test('capturePageReplayStep keeps empty-selector submit captures as no-ops', async () => {
    const captureReplayStep = jest.fn();
    jest.resetModules();
    jest.doMock('../../src/core/skill-memory', () => ({
      captureReplayStep,
    }));

    const { capturePageReplayStep } = await import('../../src/tools/_shared/replay-recorder');
    capturePageReplayStep({
      target: () => ({ _targetId: 'target-submit' }),
    }, {
      kind: 'click',
      selectors: [],
    });

    expect(captureReplayStep).not.toHaveBeenCalled();
  });
});
