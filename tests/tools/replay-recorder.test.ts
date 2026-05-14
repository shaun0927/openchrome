import {
  peekRecorderBuffer,
  resetRecorderBuffers,
} from '../../src/core/skill-memory';
import { captureBackendNodeReplayStep } from '../../src/tools/_shared/replay-recorder';

describe('replay recorder shared helpers', () => {
  afterEach(() => resetRecorderBuffers());

  test('captures a replay step from backendNodeId using generated CSS selectors', async () => {
    const cdpClient = {
      send: jest.fn()
        .mockResolvedValueOnce({ object: { objectId: 'object-1' } })
        .mockResolvedValueOnce({ result: { value: ['#submit', 'button[data-testid="submit"]'] } }),
    };
    const page = {
      target: () => ({ _targetId: 'target-helper' }),
    };

    await captureBackendNodeReplayStep({
      cdpClient,
      page,
      backendNodeId: 123,
      kind: 'click',
    });

    expect(cdpClient.send).toHaveBeenNthCalledWith(1, page, 'DOM.resolveNode', { backendNodeId: 123 });
    expect(peekRecorderBuffer('target-helper')).toEqual([
      {
        kind: 'click',
        selectors: [
          { type: 'css', value: '#submit' },
          { type: 'css', value: 'button[data-testid="submit"]' },
        ],
      },
    ]);
  });
});
