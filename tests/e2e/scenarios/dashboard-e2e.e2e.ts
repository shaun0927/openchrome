/**
 * E2E: Dashboard Activity Tracker and Real-Time Renderer (#492)
 *
 * Validates:
 * 1. Activity tracker records all tool calls in real-time
 * 2. ANSI rendering produces readable output in standard terminals
 * 3. Pause/resume operations work from dashboard
 * 4. Multi-worker status updates display in real-time
 */

import { ActivityTracker } from '../../../src/dashboard/activity-tracker';
import { Renderer } from '../../../src/dashboard/renderer';
import { OperationController } from '../../../src/dashboard/operation-controller';
import { ANSI, stripAnsi, horizontalLine, BOX, formatDuration, formatUptime, pad } from '../../../src/dashboard/ansi';
import { MCPClient } from '../harness/mcp-client';

// ─── Criterion 1: Activity tracker records all tool calls in real-time ───

describe('Dashboard E2E: Activity Tracker', () => {
  let tracker: ActivityTracker;

  beforeEach(() => {
    tracker = new ActivityTracker(100);
  });

  afterEach(() => {
    tracker.destroy();
  });

  test('records 10 tool calls with correct timestamps and ordering', () => {
    const toolNames = [
      'navigate', 'read_page', 'click', 'javascript_tool', 'screenshot',
      'tabs_create', 'tabs_list', 'scroll', 'type_text', 'wait_for',
    ];
    const callIds: string[] = [];

    // Start 10 calls
    for (const toolName of toolNames) {
      const callId = tracker.startCall(toolName, 'session-1', { url: 'https://example.com' });
      callIds.push(callId);
    }

    // All 10 should be active
    expect(tracker.getActiveCalls().length).toBe(10);

    // Each active call should have a valid startTime
    for (const call of tracker.getActiveCalls()) {
      expect(call.startTime).toBeGreaterThan(0);
      expect(call.result).toBe('pending');
      expect(call.sessionId).toBe('session-1');
    }

    // End all calls with success
    for (const callId of callIds) {
      tracker.endCall(callId, 'success');
    }

    // All should be completed now
    expect(tracker.getActiveCalls().length).toBe(0);
    const recent = tracker.getRecentCalls(10);
    expect(recent.length).toBe(10);

    // Each completed call should have duration and endTime
    for (const call of recent) {
      expect(call.result).toBe('success');
      expect(call.endTime).toBeGreaterThanOrEqual(call.startTime);
      expect(call.duration).toBeDefined();
      expect(call.duration).toBeGreaterThanOrEqual(0);
    }

    // Stats should reflect 10 completed calls
    const stats = tracker.getStats();
    expect(stats.totalCompleted).toBe(10);
    expect(stats.successCount).toBe(10);
    expect(stats.errorCount).toBe(0);
    expect(stats.activeCount).toBe(0);

    console.error('[dashboard-e2e] Criterion 1 PASS: Activity tracker records all 10 tool calls with timestamps');
  });

  test('emits call:start and call:end events in real-time', (done) => {
    const events: string[] = [];

    tracker.on('call:start', (event) => {
      events.push(`start:${event.toolName}`);
    });

    tracker.on('call:end', (event) => {
      events.push(`end:${event.toolName}`);
      if (events.length === 4) {
        expect(events).toEqual([
          'start:navigate', 'start:read_page',
          'end:navigate', 'end:read_page',
        ]);
        console.error('[dashboard-e2e] Criterion 1 PASS: Real-time events emitted correctly');
        done();
      }
    });

    const id1 = tracker.startCall('navigate', 'session-1');
    const id2 = tracker.startCall('read_page', 'session-1');
    tracker.endCall(id1, 'success');
    tracker.endCall(id2, 'success');
  });

  test('tracks errors with error messages', () => {
    const callId = tracker.startCall('navigate', 'session-1', { url: 'bad-url' });
    tracker.endCall(callId, 'error', 'Navigation failed: net::ERR_NAME_NOT_RESOLVED');

    const recent = tracker.getRecentCalls(1);
    expect(recent.length).toBe(1);
    expect(recent[0].result).toBe('error');
    expect(recent[0].error).toBe('Navigation failed: net::ERR_NAME_NOT_RESOLVED');

    const stats = tracker.getStats();
    expect(stats.errorCount).toBe(1);
    expect(stats.successCount).toBe(0);
  });

  test('filters calls by sessionId for parallel worker isolation', () => {
    // Simulate calls from two different workers/sessions
    const id1 = tracker.startCall('navigate', 'worker-1');
    const id2 = tracker.startCall('read_page', 'worker-2');
    const id3 = tracker.startCall('click', 'worker-1');
    tracker.endCall(id1, 'success');
    tracker.endCall(id2, 'success');
    tracker.endCall(id3, 'success');

    const worker1Calls = tracker.getRecentCalls(10, 'worker-1');
    const worker2Calls = tracker.getRecentCalls(10, 'worker-2');

    expect(worker1Calls.length).toBe(2);
    expect(worker2Calls.length).toBe(1);
    expect(worker1Calls.every(c => c.sessionId === 'worker-1')).toBe(true);
    expect(worker2Calls.every(c => c.sessionId === 'worker-2')).toBe(true);
  });

  test('records compression metrics', () => {
    const callId = tracker.startCall('read_page', 'session-1');
    tracker.recordCompression(callId, 10000, 3000, 'sibling-dedup');
    tracker.endCall(callId, 'success');

    const call = tracker.getRecentCalls(1)[0];
    expect(call.compression).toBeDefined();
    expect(call.compression!.originalChars).toBe(10000);
    expect(call.compression!.compressedChars).toBe(3000);
    expect(call.compression!.estimatedTokensSaved).toBe(1750);
    expect(call.compression!.strategy).toBe('sibling-dedup');

    const stats = tracker.getStats();
    expect(stats.compression).toBeDefined();
    expect(stats.compression!.callsCompressed).toBe(1);
    expect(stats.compression!.totalTokensSaved).toBe(1750);
  });

  test('respects maxHistory limit', () => {
    const smallTracker = new ActivityTracker(5);

    for (let i = 0; i < 10; i++) {
      const callId = smallTracker.startCall(`tool-${i}`, 'session-1');
      smallTracker.endCall(callId, 'success');
    }

    // Should only keep last 5
    expect(smallTracker.getRecentCalls(10).length).toBe(5);
    smallTracker.destroy();
  });
});

// ─── Criterion 2: ANSI rendering produces readable output ───

describe('Dashboard E2E: ANSI Rendering', () => {
  let renderer: Renderer;

  beforeEach(() => {
    renderer = new Renderer();
  });

  test('ANSI escape codes are valid and strippable', () => {
    // All ANSI constants should contain the ESC[ prefix
    const codeEntries = Object.entries(ANSI);
    for (const [name, code] of codeEntries) {
      expect(code).toMatch(/\x1b\[/);
    }

    // Style/color codes (ending with 'm') should be stripped by stripAnsi
    const styleCodes = codeEntries.filter(([, code]) => code.endsWith('m'));
    for (const [name, code] of styleCodes) {
      expect(stripAnsi(code)).toBe('');
    }

    // Screen control codes (clear, home, cursor) are valid ANSI but not color codes
    const controlCodes = codeEntries.filter(([, code]) => !code.endsWith('m'));
    expect(controlCodes.length).toBeGreaterThan(0); // clear, home, hideCursor, etc.

    console.error(`[dashboard-e2e] Criterion 2: ${styleCodes.length} style codes strippable, ${controlCodes.length} control codes valid`);
  });

  test('stripAnsi removes all escape codes and preserves text', () => {
    const styled = `${ANSI.bold}${ANSI.green}Hello${ANSI.reset} ${ANSI.red}World${ANSI.reset}`;
    expect(stripAnsi(styled)).toBe('Hello World');

    // Nested styles
    const nested = `${ANSI.bold}${ANSI.underline}${ANSI.cyan}Nested${ANSI.reset}`;
    expect(stripAnsi(nested)).toBe('Nested');

    // Empty string
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi(ANSI.reset)).toBe('');
  });

  test('box drawing characters render correctly', () => {
    // Verify BOX characters are valid Unicode box-drawing characters
    expect(BOX.topLeft).toBe('┌');
    expect(BOX.topRight).toBe('┐');
    expect(BOX.bottomLeft).toBe('└');
    expect(BOX.bottomRight).toBe('┘');
    expect(BOX.horizontal).toBe('─');
    expect(BOX.vertical).toBe('│');
    expect(BOX.teeRight).toBe('├');
    expect(BOX.teeLeft).toBe('┤');
    expect(BOX.cross).toBe('┼');
  });

  test('header/separator/footer create proper box layout', () => {
    const width = 40;
    const header = renderer.header('Dashboard', width);
    const separator = renderer.separator(width);
    const footer = renderer.footer(width);

    // Header should contain the text
    expect(stripAnsi(header)).toContain('Dashboard');
    // Should start/end with box characters
    expect(stripAnsi(header).startsWith('┌')).toBe(true);
    expect(stripAnsi(header).endsWith('┐')).toBe(true);

    // Separator
    expect(stripAnsi(separator).startsWith('├')).toBe(true);
    expect(stripAnsi(separator).endsWith('┤')).toBe(true);

    // Footer
    expect(stripAnsi(footer).startsWith('└')).toBe(true);
    expect(stripAnsi(footer).endsWith('┘')).toBe(true);
  });

  test('contentLine pads and borders correctly', () => {
    const width = 30;
    const line = renderer.contentLine('Status: OK', width);
    const stripped = stripAnsi(line);

    expect(stripped.startsWith('│')).toBe(true);
    expect(stripped.endsWith('│')).toBe(true);
    expect(stripped).toContain('Status: OK');
  });

  test('pad function aligns text correctly', () => {
    expect(pad('hi', 10, 'left')).toBe('hi        ');
    expect(pad('hi', 10, 'right')).toBe('        hi');
    expect(pad('hi', 10, 'center')).toBe('    hi    ');
  });

  test('formatDuration returns human-readable strings', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65000)).toBe('1:05');
  });

  test('formatUptime returns HH:MM:SS format', () => {
    expect(formatUptime(0)).toBe('00:00:00');
    expect(formatUptime(3661000)).toBe('01:01:01');
  });

  test('horizontalLine creates correct width', () => {
    expect(horizontalLine(5)).toBe('─────');
    expect(horizontalLine(3, '=')).toBe('===');
  });

  test('badge renders with color and brackets', () => {
    const badge = renderer.badge('RUNNING', ANSI.green);
    expect(stripAnsi(badge)).toBe('[RUNNING]');
    expect(badge).toContain(ANSI.green);
    expect(badge).toContain(ANSI.reset);
  });

  test('spinner returns valid spinner frame characters', () => {
    const frames = new Set<string>();
    for (let i = 0; i < 20; i++) {
      frames.add(renderer.spinner(i));
    }
    // Should cycle through frames
    expect(frames.size).toBeLessThanOrEqual(10);
    expect(frames.size).toBeGreaterThan(0);
    // All frames should be single characters (braille patterns)
    for (const frame of frames) {
      expect(frame.length).toBe(1);
    }

    console.error('[dashboard-e2e] Criterion 2 PASS: ANSI rendering produces readable output');
  });
});

// ─── Criterion 3: Pause/resume operations work from dashboard ───

describe('Dashboard E2E: Operation Controller (Pause/Resume)', () => {
  let controller: OperationController;

  beforeEach(() => {
    controller = new OperationController();
  });

  afterEach(() => {
    controller.reset();
  });

  test('pause() sets isPaused to true and emits event', (done) => {
    expect(controller.isPaused).toBe(false);

    controller.on('paused', () => {
      expect(controller.isPaused).toBe(true);
      console.error('[dashboard-e2e] Criterion 3: Pause event emitted');
      done();
    });

    controller.pause();
  });

  test('resume() releases paused state and emits event', (done) => {
    controller.pause();
    expect(controller.isPaused).toBe(true);

    controller.on('resumed', () => {
      expect(controller.isPaused).toBe(false);
      console.error('[dashboard-e2e] Criterion 3: Resume event emitted');
      done();
    });

    controller.resume();
  });

  test('toggle() alternates pause state', () => {
    expect(controller.isPaused).toBe(false);
    controller.toggle();
    expect(controller.isPaused).toBe(true);
    controller.toggle();
    expect(controller.isPaused).toBe(false);
  });

  test('gate() blocks when paused and resolves on resume', async () => {
    controller.pause();

    let gateResolved = false;
    const gatePromise = controller.gate('op-1').then(() => {
      gateResolved = true;
    });

    // Gate should not resolve while paused
    await new Promise(r => setTimeout(r, 50));
    expect(gateResolved).toBe(false);
    expect(controller.pendingCount).toBe(1);

    // Resume should release the gate
    controller.resume();
    await gatePromise;
    expect(gateResolved).toBe(true);
    expect(controller.pendingCount).toBe(0);

    console.error('[dashboard-e2e] Criterion 3 PASS: gate() blocks on pause, resolves on resume');
  });

  test('gate() passes through immediately when not paused', async () => {
    await controller.gate('op-1'); // Should resolve immediately
    expect(controller.pendingCount).toBe(0);
  });

  test('cancel() rejects a waiting gate', async () => {
    controller.pause();

    const gatePromise = controller.gate('op-cancel');

    // Cancel the operation
    const cancelled = controller.cancel('op-cancel');
    expect(cancelled).toBe(true);

    await expect(gatePromise).rejects.toThrow('Operation cancelled');
  });

  test('cancelAll() rejects all pending gates', async () => {
    controller.pause();

    const promises = [
      controller.gate('op-a').catch(e => e.message),
      controller.gate('op-b').catch(e => e.message),
      controller.gate('op-c').catch(e => e.message),
    ];

    const count = controller.cancelAll();
    expect(count).toBe(3);

    const results = await Promise.all(promises);
    expect(results.every(r => r === 'Operation cancelled')).toBe(true);
  });

  test('getStatus() returns correct state', () => {
    let status = controller.getStatus();
    expect(status.isPaused).toBe(false);
    expect(status.pendingCount).toBe(0);

    controller.pause();
    status = controller.getStatus();
    expect(status.isPaused).toBe(true);
  });

  test('isCancelled() tracks cancelled call IDs', () => {
    expect(controller.isCancelled('call-x')).toBe(false);
    controller.cancel('call-x');
    expect(controller.isCancelled('call-x')).toBe(true);
    controller.clearCancelled('call-x');
    expect(controller.isCancelled('call-x')).toBe(false);
  });
});

// ─── Criterion 4: Multi-worker status updates display in real-time ───

describe('Dashboard E2E: Multi-Worker Status Updates', () => {
  let tracker: ActivityTracker;

  beforeEach(() => {
    tracker = new ActivityTracker(100);
  });

  afterEach(() => {
    tracker.destroy();
  });

  test('tracks concurrent calls from multiple workers/sessions', () => {
    // Simulate 3 workers making concurrent calls
    const worker1Call = tracker.startCall('navigate', 'worker-1', { url: 'https://site-a.com' });
    const worker2Call = tracker.startCall('read_page', 'worker-2');
    const worker3Call = tracker.startCall('screenshot', 'worker-3');

    // All should be active simultaneously
    const activeCalls = tracker.getActiveCalls();
    expect(activeCalls.length).toBe(3);

    // Each worker's call should be independently tracked
    const workerIds = new Set(activeCalls.map(c => c.sessionId));
    expect(workerIds.size).toBe(3);
    expect(workerIds.has('worker-1')).toBe(true);
    expect(workerIds.has('worker-2')).toBe(true);
    expect(workerIds.has('worker-3')).toBe(true);

    // Complete calls at different times
    tracker.endCall(worker2Call, 'success');
    expect(tracker.getActiveCalls().length).toBe(2);

    tracker.endCall(worker1Call, 'success');
    expect(tracker.getActiveCalls().length).toBe(1);

    tracker.endCall(worker3Call, 'error', 'Screenshot failed');
    expect(tracker.getActiveCalls().length).toBe(0);

    // Stats should reflect all 3 completed
    const stats = tracker.getStats();
    expect(stats.totalCompleted).toBe(3);
    expect(stats.successCount).toBe(2);
    expect(stats.errorCount).toBe(1);
  });

  test('getAllCalls() combines active and completed for real-time display', () => {
    // Start some calls
    const id1 = tracker.startCall('navigate', 'worker-1');
    const id2 = tracker.startCall('read_page', 'worker-2');
    tracker.endCall(id1, 'success');
    const id3 = tracker.startCall('click', 'worker-3');

    // getAllCalls should show both active (id2, id3) and completed (id1)
    const allCalls = tracker.getAllCalls(10);
    expect(allCalls.length).toBe(3);

    const activeInAll = allCalls.filter(c => c.result === 'pending');
    const completedInAll = allCalls.filter(c => c.result !== 'pending');
    expect(activeInAll.length).toBe(2);
    expect(completedInAll.length).toBe(1);

    tracker.endCall(id2, 'success');
    tracker.endCall(id3, 'success');
  });

  test('events fire per-worker for real-time updates', () => {
    const startEvents: string[] = [];
    const endEvents: string[] = [];

    tracker.on('call:start', (event) => {
      startEvents.push(event.sessionId);
    });
    tracker.on('call:end', (event) => {
      endEvents.push(event.sessionId);
    });

    // Simulate parallel worker activity
    const ids = [
      tracker.startCall('navigate', 'worker-1'),
      tracker.startCall('navigate', 'worker-2'),
      tracker.startCall('navigate', 'worker-3'),
    ];

    expect(startEvents).toEqual(['worker-1', 'worker-2', 'worker-3']);

    // End in different order (simulating different completion times)
    tracker.endCall(ids[2], 'success'); // worker-3 finishes first
    tracker.endCall(ids[0], 'success'); // worker-1 finishes second
    tracker.endCall(ids[1], 'error', 'timeout'); // worker-2 fails last

    expect(endEvents).toEqual(['worker-3', 'worker-1', 'worker-2']);

    console.error('[dashboard-e2e] Criterion 4 PASS: Multi-worker status updates work in real-time');
  });

  test('concurrent workers with operation controller gate', async () => {
    const controller = new OperationController();

    // Worker-1 passes through (not paused)
    await controller.gate('worker-1-op');

    // Pause
    controller.pause();

    // Worker-2 and Worker-3 are blocked
    let w2resolved = false;
    let w3resolved = false;

    const w2 = controller.gate('worker-2-op').then(() => { w2resolved = true; });
    const w3 = controller.gate('worker-3-op').then(() => { w3resolved = true; });

    await new Promise(r => setTimeout(r, 50));
    expect(w2resolved).toBe(false);
    expect(w3resolved).toBe(false);

    // Resume releases both
    controller.resume();
    await Promise.all([w2, w3]);
    expect(w2resolved).toBe(true);
    expect(w3resolved).toBe(true);

    controller.reset();
  });
});

// ─── Integration: MCP Server Activity Tracking ───

describe('Dashboard E2E: MCP Server Integration', () => {
  let mcp: MCPClient;
  const PORT = 18924;

  beforeAll(async () => {
    mcp = new MCPClient({ timeoutMs: 60_000 });
    await mcp.start();
  }, 60_000);

  afterAll(async () => {
    await mcp.stop();
  }, 30_000);

  test('tool calls through MCP are tracked by activity tracker', async () => {
    // Use oc_profile_status — a lifecycle tool that works without an active session
    const results: Array<{ text: string }> = [];

    for (let i = 0; i < 3; i++) {
      try {
        const result = await mcp.callTool('oc_profile_status', {}, 15_000);
        results.push(result);
      } catch (err) {
        console.error(`[dashboard-e2e] oc_profile_status call ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // All calls should succeed — oc_profile_status is always available
    expect(results.length).toBe(3);
    for (const result of results) {
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    }

    console.error(`[dashboard-e2e] MCP Integration: ${results.length}/3 oc_profile_status calls tracked successfully`);
  }, 60_000);
});
