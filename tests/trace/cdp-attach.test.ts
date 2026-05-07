import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  attachRecorderToPage,
  traceEnvEnabled,
} from '../../src/trace/cdp-attach';
import {
  TraceRecorder,
  _resetTraceRecorderForTests,
  getTraceRecorder,
} from '../../src/trace/recorder';
import { TraceStorage } from '../../src/trace/storage';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attach-'));
}

/**
 * Build a minimal page-like object satisfying the structural type the
 * attach helper consumes. Tests don't need a real puppeteer Page.
 */
function fakePage(targetId: string): {
  emitter: EventEmitter;
  cdp: EventEmitter;
  page: Parameters<typeof attachRecorderToPage>[0];
} {
  const emitter = new EventEmitter();
  const cdp = new EventEmitter();
  const page = {
    target: () => ({ _targetId: targetId, type: () => 'page' as const }),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return undefined as unknown as void;
    },
    createCDPSession: async () => ({
      on: (event: string, listener: (...args: unknown[]) => void) => {
        cdp.on(event, listener);
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        cdp.off(event, listener);
      },
    }),
  } as unknown as Parameters<typeof attachRecorderToPage>[0];
  return { emitter, cdp, page };
}

describe('traceEnvEnabled', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPENCHROME_TRACE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCHROME_TRACE;
    else process.env.OPENCHROME_TRACE = prev;
  });

  test('returns true for "1" / "on" / "true"', () => {
    process.env.OPENCHROME_TRACE = '1';
    expect(traceEnvEnabled()).toBe(true);
    process.env.OPENCHROME_TRACE = 'on';
    expect(traceEnvEnabled()).toBe(true);
    process.env.OPENCHROME_TRACE = 'true';
    expect(traceEnvEnabled()).toBe(true);
  });

  test('returns false when unset / empty / "0" / "off"', () => {
    delete process.env.OPENCHROME_TRACE;
    expect(traceEnvEnabled()).toBe(false);
    process.env.OPENCHROME_TRACE = '';
    expect(traceEnvEnabled()).toBe(false);
    process.env.OPENCHROME_TRACE = '0';
    expect(traceEnvEnabled()).toBe(false);
    process.env.OPENCHROME_TRACE = 'off';
    expect(traceEnvEnabled()).toBe(false);
  });
});

describe('attachRecorderToPage — env-gated', () => {
  let prev: string | undefined;
  let root: string | undefined;

  beforeEach(() => {
    prev = process.env.OPENCHROME_TRACE;
    _resetTraceRecorderForTests();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCHROME_TRACE;
    else process.env.OPENCHROME_TRACE = prev;
    _resetTraceRecorderForTests();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  test('returns null without side effects when OPENCHROME_TRACE is unset', async () => {
    delete process.env.OPENCHROME_TRACE;
    const { page } = fakePage('t1');
    const result = await attachRecorderToPage(page, { sessionId: 't1' });
    expect(result).toBeNull();
  });

  test('starts the global recorder and subscribes to CDP events when enabled', async () => {
    root = tempRoot();
    process.env.OPENCHROME_TRACE = '1';
    _resetTraceRecorderForTests();
    const recorder = getTraceRecorder({
      storage: new TraceStorage({ rootDir: root }),
      enabled: true,
      bufferSize: 100,
      flushIntervalMs: 24 * 60 * 60 * 1000, // effectively disable timer in test
    });
    expect(recorder.isEnabled()).toBe(true);

    const { page, cdp, emitter } = fakePage('t1');
    const handle = await attachRecorderToPage(page, {
      sessionId: 't1',
      domain: 'amazon.com',
    });
    expect(handle).not.toBeNull();

    // Emit a CDP event — should land in the recorder buffer
    cdp.emit('Page.frameNavigated', { frame: { url: 'https://a' } });
    expect(recorder._peekBuffer('t1').length).toBeGreaterThanOrEqual(1);

    // Page close ends the session
    emitter.emit('close');
    await new Promise((res) => setImmediate(res));
  });

  test('emits a console error and returns null when recorder singleton was built before env was set', async () => {
    delete process.env.OPENCHROME_TRACE;
    _resetTraceRecorderForTests();
    const built: TraceRecorder = getTraceRecorder();
    expect(built.isEnabled()).toBe(false);
    process.env.OPENCHROME_TRACE = '1';

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { page } = fakePage('t-late');
    const result = await attachRecorderToPage(page, { sessionId: 't-late' });
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('OPENCHROME_TRACE is set but the recorder singleton is disabled'),
    );
    errSpy.mockRestore();
  });
});
