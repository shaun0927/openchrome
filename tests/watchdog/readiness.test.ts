/**
 * Unit tests for the /ready readiness state machine (#862).
 * Uses fake clocks; no real Chrome process.
 */

/// <reference types="jest" />

import {
  ReadinessMachine,
  setReadinessMachine,
  resetReadinessMachine,
  getReadinessMachine,
  setComponent,
} from '../../src/watchdog/readiness';
import { HealthEndpoint } from '../../src/watchdog/health-endpoint';
import * as http from 'http';

// ─── Helper: fire HTTP GET and collect status + body ────────────────────────

function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    }).on('error', reject);
  });
}

// Minimal HealthData provider used by HealthEndpoint constructor
const minimalProvider = () => ({
  status: 'ok' as const,
  uptime: 0,
  memory: process.memoryUsage(),
  eventLoop: { maxDriftMs: 0, warnCount: 0 },
});

// ─── ReadinessMachine unit tests ─────────────────────────────────────────────

describe('ReadinessMachine', () => {
  beforeEach(() => {
    delete process.env.OPENCHROME_READY_REQUIRES;
    resetReadinessMachine();
  });

  afterEach(() => {
    delete process.env.OPENCHROME_READY_REQUIRES;
    resetReadinessMachine();
  });

  test('starts with all components in "starting" state', () => {
    const m = new ReadinessMachine();
    const { ready, components, blockers } = m.getReadiness();
    expect(ready).toBe(false);
    expect(components.chrome).toBe('starting');
    expect(components.tools).toBe('starting');
    expect(components.watchdogs).toBe('starting');
    expect(blockers).toEqual(expect.arrayContaining(['chrome', 'tools', 'watchdogs']));
  });

  test('returns 200-equivalent (ready=true) only when all required components are ok', () => {
    const m = new ReadinessMachine();
    m.setComponent('chrome', 'ok');
    expect(m.getReadiness().ready).toBe(false); // tools + watchdogs still starting

    m.setComponent('tools', 'ok');
    expect(m.getReadiness().ready).toBe(false); // watchdogs still starting

    m.setComponent('watchdogs', 'ok');
    const { ready, components, blockers } = m.getReadiness();
    expect(ready).toBe(true);
    expect(components).toEqual({ chrome: 'ok', tools: 'ok', watchdogs: 'ok' });
    expect(blockers).toBeUndefined();
  });

  test('flips back to not-ready when chrome transitions to "failing"', () => {
    const m = new ReadinessMachine();
    m.setComponent('chrome', 'ok');
    m.setComponent('tools', 'ok');
    m.setComponent('watchdogs', 'ok');
    expect(m.getReadiness().ready).toBe(true);

    m.setComponent('chrome', 'failing');
    const { ready, blockers, components } = m.getReadiness();
    expect(ready).toBe(false);
    expect(blockers).toEqual(['chrome']);
    expect(components.chrome).toBe('failing');
  });

  test('blockers list only contains components that are not ok', () => {
    const m = new ReadinessMachine();
    m.setComponent('tools', 'ok');
    m.setComponent('watchdogs', 'ok');
    const { ready, blockers } = m.getReadiness();
    expect(ready).toBe(false);
    expect(blockers).toEqual(['chrome']);
  });

  test('OPENCHROME_READY_REQUIRES=chrome: ready when only chrome is ok, ignores tools/watchdogs', () => {
    const m = new ReadinessMachine('chrome');
    m.setComponent('chrome', 'ok');
    // tools and watchdogs still "starting" — should not block
    const { ready, components } = m.getReadiness();
    expect(ready).toBe(true);
    expect(components.tools).toBe('starting');
    expect(components.watchdogs).toBe('starting');
  });

  test('OPENCHROME_READY_REQUIRES=chrome,tools: requires only those two', () => {
    const m = new ReadinessMachine('chrome,tools');
    m.setComponent('chrome', 'ok');
    expect(m.getReadiness().ready).toBe(false);

    m.setComponent('tools', 'ok');
    expect(m.getReadiness().ready).toBe(true);
  });

  test('env var OPENCHROME_READY_REQUIRES is picked up by default constructor', () => {
    process.env.OPENCHROME_READY_REQUIRES = 'chrome';
    const m = new ReadinessMachine();
    m.setComponent('chrome', 'ok');
    expect(m.getReadiness().ready).toBe(true);
  });

  test('getComponent returns current state', () => {
    const m = new ReadinessMachine();
    expect(m.getComponent('chrome')).toBe('starting');
    m.setComponent('chrome', 'ok');
    expect(m.getComponent('chrome')).toBe('ok');
  });

  test('getRequired reflects parsed required set', () => {
    const m = new ReadinessMachine('chrome,tools');
    expect(m.getRequired()).toEqual(new Set(['chrome', 'tools']));
  });

  test('invalid component names in OPENCHROME_READY_REQUIRES are silently dropped', () => {
    const m = new ReadinessMachine('chrome,bogus');
    // only "chrome" is valid — falls back to just chrome
    expect(m.getRequired()).toEqual(new Set(['chrome']));
    m.setComponent('chrome', 'ok');
    expect(m.getReadiness().ready).toBe(true);
  });

  test('empty OPENCHROME_READY_REQUIRES falls back to all three components', () => {
    const m = new ReadinessMachine('');
    expect(m.getRequired()).toEqual(new Set(['chrome', 'tools', 'watchdogs']));
  });
});

// ─── Singleton helpers ────────────────────────────────────────────────────────

describe('readiness singleton', () => {
  afterEach(() => {
    resetReadinessMachine();
    delete process.env.OPENCHROME_READY_REQUIRES;
  });

  test('getReadinessMachine() returns consistent singleton', () => {
    const a = getReadinessMachine();
    const b = getReadinessMachine();
    expect(a).toBe(b);
  });

  test('setReadinessMachine() replaces the singleton', () => {
    const replacement = new ReadinessMachine('chrome');
    setReadinessMachine(replacement);
    expect(getReadinessMachine()).toBe(replacement);
  });

  test('setComponent() convenience wrapper targets the singleton', () => {
    setComponent('chrome', 'ok');
    expect(getReadinessMachine().getComponent('chrome')).toBe('ok');
  });

  test('resetReadinessMachine() causes next getReadinessMachine() to create fresh instance', () => {
    const first = getReadinessMachine();
    first.setComponent('chrome', 'ok');
    resetReadinessMachine();
    const second = getReadinessMachine();
    expect(second).not.toBe(first);
    expect(second.getComponent('chrome')).toBe('starting');
  });
});

// ─── HTTP endpoint integration ────────────────────────────────────────────────

describe('HealthEndpoint /ready', () => {
  let endpoint: HealthEndpoint;
  let machine: ReadinessMachine;
  let port: number;

  beforeEach(async () => {
    resetReadinessMachine();
    machine = new ReadinessMachine();
    setReadinessMachine(machine);
    endpoint = new HealthEndpoint(minimalProvider, 0, '127.0.0.1', machine);
    await endpoint.start();
    port = endpoint.getPort();
  });

  afterEach(async () => {
    await endpoint.stop();
    resetReadinessMachine();
  });

  test('returns 503 during startup (all components starting)', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);
    expect(status).toBe(503);
    expect((body as any).ready).toBe(false);
    expect((body as any).components.chrome).toBe('starting');
    expect((body as any).blockers).toContain('chrome');
  });

  test('returns 200 once all components are ok', async () => {
    machine.setComponent('chrome', 'ok');
    machine.setComponent('tools', 'ok');
    machine.setComponent('watchdogs', 'ok');

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);
    expect(status).toBe(200);
    expect((body as any).ready).toBe(true);
    expect((body as any).components).toEqual({ chrome: 'ok', tools: 'ok', watchdogs: 'ok' });
    expect((body as any).blockers).toBeUndefined();
  });

  test('returns 503 with blockers:["chrome"] after Chrome disconnect', async () => {
    machine.setComponent('chrome', 'ok');
    machine.setComponent('tools', 'ok');
    machine.setComponent('watchdogs', 'ok');
    // Simulate Chrome going down
    machine.setComponent('chrome', 'failing');

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);
    expect(status).toBe(503);
    expect((body as any).ready).toBe(false);
    expect((body as any).blockers).toEqual(['chrome']);
    expect((body as any).components.chrome).toBe('failing');
  });

  test('OPENCHROME_READY_REQUIRES=chrome: 200 even when tools/watchdogs still starting', async () => {
    const relaxedMachine = new ReadinessMachine('chrome');
    setReadinessMachine(relaxedMachine);
    const relaxedEndpoint = new HealthEndpoint(minimalProvider, 0, '127.0.0.1', relaxedMachine);
    await relaxedEndpoint.start();
    const relaxedPort = relaxedEndpoint.getPort();

    try {
      relaxedMachine.setComponent('chrome', 'ok');
      // tools and watchdogs remain 'starting'

      const { status, body } = await httpGet(`http://127.0.0.1:${relaxedPort}/ready`);
      expect(status).toBe(200);
      expect((body as any).ready).toBe(true);
      expect((body as any).components.tools).toBe('starting');
      expect((body as any).components.watchdogs).toBe('starting');
    } finally {
      await relaxedEndpoint.stop();
    }
  });

  test('/health is unaffected by readiness state', async () => {
    // All components still starting — /health should still respond 200
    const { status } = await httpGet(`http://127.0.0.1:${port}/health`);
    expect(status).toBe(200);
  });

  test('response has Content-Type: application/json', async () => {
    const result = await new Promise<{ headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/ready`, (res) => {
        res.resume();
        resolve({ headers: res.headers });
      }).on('error', reject);
    });
    expect(result.headers['content-type']).toBe('application/json');
  });
});
