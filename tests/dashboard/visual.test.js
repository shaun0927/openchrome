#!/usr/bin/env node
/**
 * Dashboard Visual Tests - renders to stderr
 */

const {
  Renderer,
  getRenderer,
  ANSI,
  formatUptime,
  formatBytes,
} = require('../../dist/dashboard/index.js');

const { MainView } = require('../../dist/dashboard/views/main-view.js');
const { SessionsView } = require('../../dist/dashboard/views/sessions-view.js');
const { TabsView } = require('../../dist/dashboard/views/tabs-view.js');

// Mock data
const mockStats = {
  sessions: 3,
  workers: 7,
  tabs: 12,
  queueSize: 2,
  memoryUsage: 45 * 1024 * 1024,
  uptime: 932000,
  status: 'running',
};

const mockCalls = [
  {
    id: 'call-1',
    toolName: 'navigate',
    sessionId: 'sess-abc123',
    args: { url: 'https://example.com/long/path/to/page' },
    startTime: Date.now() - 1000,
    result: 'pending',
  },
  {
    id: 'call-2',
    toolName: 'read_page',
    sessionId: 'sess-abc123',
    args: {},
    startTime: Date.now() - 2000,
    endTime: Date.now() - 1958,
    duration: 42,
    result: 'success',
  },
  {
    id: 'call-3',
    toolName: 'javascript',
    sessionId: 'sess-def456',
    args: { javascript: 'document.querySelector("#main")' },
    startTime: Date.now() - 3000,
    endTime: Date.now() - 2982,
    duration: 18,
    result: 'success',
  },
  {
    id: 'call-4',
    toolName: 'click',
    sessionId: 'sess-abc123',
    args: { selector: '#submit-btn' },
    startTime: Date.now() - 4000,
    endTime: Date.now() - 3911,
    duration: 89,
    result: 'success',
  },
  {
    id: 'call-5',
    toolName: 'navigate',
    sessionId: 'sess-ghi789',
    args: { url: 'https://api.example.com' },
    startTime: Date.now() - 5000,
    endTime: Date.now() - 4797,
    duration: 203,
    result: 'error',
    error: 'Connection timeout',
  },
];

const mockSessions = [
  { id: 'sess-abc123', workerCount: 3, tabCount: 5, createdAt: Date.now() - 60000, lastActivity: Date.now() - 1000 },
  { id: 'sess-def456', workerCount: 2, tabCount: 4, createdAt: Date.now() - 120000, lastActivity: Date.now() - 30000 },
  { id: 'sess-ghi789', workerCount: 2, tabCount: 3, createdAt: Date.now() - 300000, lastActivity: Date.now() - 60000 },
];

const mockTabs = [
  { targetId: 'target-001', sessionId: 'sess-abc123', workerId: 'worker-1', url: 'https://example.com', title: 'Example' },
  { targetId: 'target-002', sessionId: 'sess-abc123', workerId: 'worker-1', url: 'https://google.com', title: 'Google' },
  { targetId: 'target-003', sessionId: 'sess-abc123', workerId: 'worker-2', url: 'https://github.com', title: 'GitHub' },
  { targetId: 'target-004', sessionId: 'sess-def456', workerId: 'default', url: 'https://docs.example.com/api/reference', title: 'API Docs' },
];

const renderer = new Renderer();
const size = { columns: 80, rows: 24 };

console.log('\n' + '='.repeat(80));
console.log('VISUAL TEST: Main View (Activity)');
console.log('='.repeat(80) + '\n');

const mainView = new MainView(renderer);
const mainLines = mainView.render({
  stats: mockStats,
  calls: mockCalls,
  version: '3.0.4',
  spinnerFrame: 5,
}, size);

mainLines.forEach(line => console.log(line));

console.log('\n' + '='.repeat(80));
console.log('VISUAL TEST: Sessions View');
console.log('='.repeat(80) + '\n');

const sessionsView = new SessionsView(renderer);
const sessionLines = sessionsView.render({
  sessions: mockSessions,
  selectedIndex: 1,
  version: '3.0.4',
}, size);

sessionLines.forEach(line => console.log(line));

console.log('\n' + '='.repeat(80));
console.log('VISUAL TEST: Tabs View');
console.log('='.repeat(80) + '\n');

const tabsView = new TabsView(renderer);
const tabLines = tabsView.render({
  tabs: mockTabs,
  selectedIndex: 0,
  version: '3.0.4',
}, size);

tabLines.forEach(line => console.log(line));

console.log('\n' + '='.repeat(80));
console.log('VISUAL TEST: Main View (Paused State)');
console.log('='.repeat(80) + '\n');

const pausedLines = mainView.render({
  stats: { ...mockStats, status: 'paused' },
  calls: mockCalls,
  version: '3.0.4',
  spinnerFrame: 0,
}, size);

pausedLines.forEach(line => console.log(line));

console.log('\n' + '='.repeat(80));
console.log('VISUAL TEST: Empty Activity View');
console.log('='.repeat(80) + '\n');

const emptyLines = mainView.render({
  stats: { ...mockStats, sessions: 0, workers: 0, tabs: 0, queueSize: 0 },
  calls: [],
  version: '3.0.4',
  spinnerFrame: 0,
}, size);

emptyLines.forEach(line => console.log(line));

console.log('\nVisual tests complete! Check the output above for proper formatting.');
