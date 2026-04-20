import { createBudget, isLegacyBudgetMode } from '../../src/utils/budget';
import { SessionInitBudgetExhausted } from '../../src/cdp/errors';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Budget', () => {
  test('root remaining decreases monotonically and never negative', async () => {
    const b = createBudget(200, 'root');
    const r1 = b.remaining();
    expect(r1).toBeGreaterThan(150);
    expect(r1).toBeLessThanOrEqual(200);
    await tick(80);
    const r2 = b.remaining();
    expect(r2).toBeLessThan(r1);
    expect(r2).toBeGreaterThanOrEqual(0);
    await tick(200);
    expect(b.remaining()).toBe(0);
    expect(b.isExpired()).toBe(true);
  });

  test('slice(fraction) yields roughly remaining*fraction ms', () => {
    const b = createBudget(1000, 'root');
    const child = b.slice(0.3, 'launch');
    const r = child.remaining();
    // Allow for 50ms scheduling jitter.
    expect(r).toBeGreaterThanOrEqual(250);
    expect(r).toBeLessThanOrEqual(300);
    expect(child.label).toBe('root/launch');
  });

  test('child cannot outlive parent', async () => {
    const b = createBudget(100, 'root');
    const child = b.slice(1.0, 'long');
    expect(child.remaining()).toBeLessThanOrEqual(100);
    await tick(120);
    expect(b.isExpired()).toBe(true);
    expect(child.isExpired()).toBe(true);
  });

  test('slice rejects invalid fraction', () => {
    const b = createBudget(1000, 'root');
    expect(() => b.slice(0, 'x')).toThrow();
    expect(() => b.slice(-1, 'x')).toThrow();
    expect(() => b.slice(1.1, 'x')).toThrow();
    expect(() => b.slice(Number.NaN, 'x')).toThrow();
  });

  test('assertNotExpired throws SessionInitBudgetExhausted when expired', async () => {
    const b = createBudget(50, 'session-init');
    await tick(80);
    expect(() => b.assertNotExpired('unit-test')).toThrow(SessionInitBudgetExhausted);
    try {
      b.assertNotExpired('unit-test');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionInitBudgetExhausted);
      const e = err as SessionInitBudgetExhausted;
      expect(e.context).toBe('unit-test');
      expect(e.stage).toBe('session-init');
      expect(e.elapsedMs).toBeGreaterThanOrEqual(50);
      expect(e.totalMs).toBeLessThanOrEqual(50);
    }
  });

  test('assertNotExpired is a no-op while budget is alive', () => {
    const b = createBudget(5000, 'alive');
    expect(() => b.assertNotExpired('unit')).not.toThrow();
  });

  test('createBudget rejects negative totalMs', () => {
    expect(() => createBudget(-1, 'x')).toThrow();
    expect(() => createBudget(Number.NaN, 'x')).toThrow();
  });

  test('elapsedMs tracks time since creation', async () => {
    const b = createBudget(1000, 'root');
    await tick(60);
    const e = b.elapsedMs();
    expect(e).toBeGreaterThanOrEqual(50);
    expect(e).toBeLessThan(200);
  });

  test('requireRemaining throws when below minimum, no-op above', async () => {
    const b = createBudget(200, 'rr');
    expect(() => b.requireRemaining(10, 'ok')).not.toThrow();
    await tick(180);
    expect(() => b.requireRemaining(50, 'short')).toThrow(SessionInitBudgetExhausted);
  });

  test('requireRemaining rejects negative minRequiredMs', () => {
    const b = createBudget(1000, 'rr');
    expect(() => b.requireRemaining(-1, 'x')).toThrow();
  });

  test('totalMs is exposed and capped by parent deadline', () => {
    const root = createBudget(500, 'p');
    const child = root.slice(1.0, 'c');
    expect(child.totalMs).toBeGreaterThan(400);
    expect(child.totalMs).toBeLessThanOrEqual(500);
  });

  test('isLegacyBudgetMode reads env flag', () => {
    const prev = process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE;
    try {
      delete process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE;
      expect(isLegacyBudgetMode()).toBe(false);
      process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE = 'LEGACY';
      expect(isLegacyBudgetMode()).toBe(true);
      process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE = 'strict';
      expect(isLegacyBudgetMode()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE;
      else process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE = prev;
    }
  });
});

describe('SessionInitBudgetExhausted', () => {
  test('is an Error and preserves instanceof across throw', () => {
    const e = new SessionInitBudgetExhausted('ctx', 'stage', 10, 20);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SessionInitBudgetExhausted);
    expect(e.name).toBe('SessionInitBudgetExhausted');
    expect(e.message).toContain('stage');
    expect(e.message).toContain('ctx');
  });
});
