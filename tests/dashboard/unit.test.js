#!/usr/bin/env node
/**
 * Dashboard Component QA Tests
 */

const {
  ActivityTracker,
  OperationController,
  ANSI,
  formatDuration,
  formatUptime,
  formatBytes,
  formatTime,
  truncate,
  pad,
  stripAnsi,
} = require('../../dist/dashboard/index.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected "${expected}", got "${actual}"`);
  }
}

function assertTrue(condition, msg = '') {
  if (!condition) {
    throw new Error(msg || 'Condition was false');
  }
}

console.log('\n=== ANSI Utilities Tests ===\n');

test('formatDuration - milliseconds', () => {
  assertEqual(formatDuration(500), '500ms');
  assertEqual(formatDuration(999), '999ms');
});

test('formatDuration - seconds', () => {
  assertEqual(formatDuration(1000), '1.0s');
  assertEqual(formatDuration(5500), '5.5s');
});

test('formatDuration - minutes', () => {
  assertEqual(formatDuration(90000), '1:30');
});

test('formatUptime - hours:minutes:seconds', () => {
  assertEqual(formatUptime(0), '00:00:00');
  assertEqual(formatUptime(3661000), '01:01:01');
});

test('formatBytes - various sizes', () => {
  assertEqual(formatBytes(500), '500B');
  assertEqual(formatBytes(1024), '1KB');
  assertEqual(formatBytes(1024 * 1024), '1MB');
});

test('truncate - short string unchanged', () => {
  assertEqual(truncate('hello', 10), 'hello');
});

test('truncate - long string truncated', () => {
  assertEqual(truncate('hello world', 6), 'hello…');
});

test('pad - left alignment', () => {
  assertEqual(pad('hi', 5, 'left'), 'hi   ');
});

test('pad - right alignment', () => {
  assertEqual(pad('hi', 5, 'right'), '   hi');
});

test('pad - center alignment', () => {
  assertEqual(pad('hi', 6, 'center'), '  hi  ');
});

test('stripAnsi - removes ANSI codes', () => {
  const colored = `${ANSI.red}hello${ANSI.reset}`;
  assertEqual(stripAnsi(colored), 'hello');
});

console.log('\n=== Activity Tracker Tests ===\n');

test('ActivityTracker - startCall returns ID', () => {
  const tracker = new ActivityTracker();
  const callId = tracker.startCall('navigate', 'sess-123', { url: 'https://example.com' });
  assertTrue(callId.startsWith('call-'), 'Call ID should start with "call-"');
});

test('ActivityTracker - getActiveCalls returns pending calls', () => {
  const tracker = new ActivityTracker();
  tracker.startCall('navigate', 'sess-123');
  tracker.startCall('click', 'sess-123');
  const active = tracker.getActiveCalls();
  assertEqual(active.length, 2, 'Should have 2 active calls');
});

test('ActivityTracker - endCall marks as success', () => {
  const tracker = new ActivityTracker();
  const callId = tracker.startCall('navigate', 'sess-123');
  tracker.endCall(callId, 'success');
  const recent = tracker.getRecentCalls(10);
  assertEqual(recent[0].result, 'success');
  assertTrue(recent[0].duration !== undefined, 'Duration should be set');
});

test('ActivityTracker - endCall marks as error', () => {
  const tracker = new ActivityTracker();
  const callId = tracker.startCall('navigate', 'sess-123');
  tracker.endCall(callId, 'error', 'Connection failed');
  const recent = tracker.getRecentCalls(10);
  assertEqual(recent[0].result, 'error');
  assertEqual(recent[0].error, 'Connection failed');
});

test('ActivityTracker - getStats returns correct counts', () => {
  const tracker = new ActivityTracker();
  const id1 = tracker.startCall('nav1', 'sess-1');
  const id2 = tracker.startCall('nav2', 'sess-1');
  tracker.startCall('nav3', 'sess-1'); // still active

  tracker.endCall(id1, 'success');
  tracker.endCall(id2, 'error', 'fail');

  const stats = tracker.getStats();
  assertEqual(stats.activeCount, 1);
  assertEqual(stats.totalCompleted, 2);
  assertEqual(stats.successCount, 1);
  assertEqual(stats.errorCount, 1);
});

test('ActivityTracker - events emitted', () => {
  const tracker = new ActivityTracker();
  let startCalled = false;
  let endCalled = false;

  tracker.on('call:start', () => { startCalled = true; });
  tracker.on('call:end', () => { endCalled = true; });

  const callId = tracker.startCall('test', 'sess');
  tracker.endCall(callId, 'success');

  assertTrue(startCalled, 'call:start should be emitted');
  assertTrue(endCalled, 'call:end should be emitted');
});

console.log('\n=== Operation Controller Tests ===\n');

test('OperationController - initial state is not paused', () => {
  const controller = new OperationController();
  assertEqual(controller.isPaused, false);
});

test('OperationController - pause sets isPaused true', () => {
  const controller = new OperationController();
  controller.pause();
  assertEqual(controller.isPaused, true);
});

test('OperationController - resume sets isPaused false', () => {
  const controller = new OperationController();
  controller.pause();
  controller.resume();
  assertEqual(controller.isPaused, false);
});

test('OperationController - toggle changes state', () => {
  const controller = new OperationController();
  controller.toggle();
  assertEqual(controller.isPaused, true);
  controller.toggle();
  assertEqual(controller.isPaused, false);
});

test('OperationController - gate resolves immediately when not paused', async () => {
  const controller = new OperationController();
  const start = Date.now();
  await controller.gate();
  const elapsed = Date.now() - start;
  assertTrue(elapsed < 50, 'Gate should resolve immediately');
});

test('OperationController - gate waits when paused', async () => {
  const controller = new OperationController();
  controller.pause();

  let resolved = false;
  const gatePromise = controller.gate().then(() => { resolved = true; });

  // Should not be resolved yet
  await new Promise(r => setTimeout(r, 10));
  assertEqual(resolved, false, 'Gate should not resolve while paused');

  // Resume and check
  controller.resume();
  await gatePromise;
  assertEqual(resolved, true, 'Gate should resolve after resume');
});

test('OperationController - cancel rejects gate', async () => {
  const controller = new OperationController();
  controller.pause();

  let error = null;
  const gatePromise = controller.gate('call-1').catch(e => { error = e; });

  controller.cancel('call-1');
  await gatePromise;

  assertTrue(error !== null, 'Gate should reject on cancel');
  assertTrue(error.message.includes('cancelled'), 'Error should mention cancelled');
});

test('OperationController - cancelAll cancels all pending', () => {
  const controller = new OperationController();
  controller.pause();

  // Start multiple gates
  controller.gate('call-1').catch(() => {});
  controller.gate('call-2').catch(() => {});
  controller.gate('call-3').catch(() => {});

  assertEqual(controller.pendingCount, 3);

  const cancelled = controller.cancelAll();
  assertEqual(cancelled, 3);
  assertEqual(controller.pendingCount, 0);
});

test('OperationController - getStatus returns correct info', () => {
  const controller = new OperationController();
  controller.pause();
  controller.gate('call-1').catch(() => {});

  const status = controller.getStatus();
  assertEqual(status.isPaused, true);
  assertEqual(status.pendingCount, 1);
});

console.log('\n=== Summary ===\n');
console.log(`Total: ${passed + failed} tests`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log();

if (failed > 0) {
  process.exit(1);
}
