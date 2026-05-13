/**
 * registry.ts unit tests (issue #889).
 *
 * Asserts:
 *   - register / deregister / list semantics
 *   - per-session isolation (process-singleton vs explicit instances)
 *   - name-collision guard (re-register replaces, returns false for "fresh")
 */

import {
  DynamicSkillsRegistry,
  getDynamicSkillsRegistry,
  _resetDynamicSkillsRegistryForTesting,
  type RegistryEntry,
} from '../../../src/pilot/dynamic-skills/registry';

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    name: 'skill_example-com__login',
    domain: 'example.com',
    skillId: 'a1b2c3d4',
    contractId: 'ctr_login_success',
    definition: {
      name: 'skill_example-com__login',
      description: 'REPLAY: login. Domain: example.com. Contract: ctr_login_success.',
      inputSchema: { type: 'object', properties: {} },
    },
    registeredAt: 1700000000000,
    ...overrides,
  };
}

describe('DynamicSkillsRegistry', () => {
  test('register returns true on fresh insert, false on replace', () => {
    const r = new DynamicSkillsRegistry();
    expect(r.register(makeEntry())).toBe(true);
    expect(r.register(makeEntry({ contractId: 'ctr_updated' }))).toBe(false);
    expect(r.get('skill_example-com__login')?.contractId).toBe('ctr_updated');
  });

  test('deregister returns true on hit, false on miss', () => {
    const r = new DynamicSkillsRegistry();
    r.register(makeEntry());
    expect(r.deregister('skill_example-com__login')).toBe(true);
    expect(r.deregister('skill_example-com__login')).toBe(false);
    expect(r.has('skill_example-com__login')).toBe(false);
  });

  test('list returns every registered entry', () => {
    const r = new DynamicSkillsRegistry();
    r.register(makeEntry({ name: 'skill_a__b', domain: 'a' }));
    r.register(makeEntry({ name: 'skill_c__d', domain: 'c' }));
    expect(r.list().map((e) => e.name).sort()).toEqual(['skill_a__b', 'skill_c__d']);
    expect(r.size).toBe(2);
  });

  test('clearAll returns the prior size and empties the registry', () => {
    const r = new DynamicSkillsRegistry();
    r.register(makeEntry({ name: 'skill_a__b' }));
    r.register(makeEntry({ name: 'skill_c__d' }));
    expect(r.clearAll()).toBe(2);
    expect(r.size).toBe(0);
    expect(r.list()).toEqual([]);
  });

  test('register throws when name/domain/skillId are empty', () => {
    const r = new DynamicSkillsRegistry();
    expect(() => r.register(makeEntry({ name: '' }))).toThrow(/name/);
    expect(() => r.register(makeEntry({ domain: '' }))).toThrow(/domain/);
    expect(() => r.register(makeEntry({ skillId: '' }))).toThrow(/skillId/);
  });
});

describe('getDynamicSkillsRegistry singleton', () => {
  afterEach(() => {
    _resetDynamicSkillsRegistryForTesting();
  });

  test('returns the same instance across calls', () => {
    const a = getDynamicSkillsRegistry();
    const b = getDynamicSkillsRegistry();
    expect(a).toBe(b);
  });

  test('test reset hook produces a fresh instance', () => {
    const a = getDynamicSkillsRegistry();
    a.register(makeEntry());
    _resetDynamicSkillsRegistryForTesting();
    const b = getDynamicSkillsRegistry();
    expect(b).not.toBe(a);
    expect(b.size).toBe(0);
  });

  test('explicit DynamicSkillsRegistry instances are isolated from the singleton', () => {
    const singleton = getDynamicSkillsRegistry();
    singleton.register(makeEntry({ name: 'skill_singleton__one' }));
    const isolated = new DynamicSkillsRegistry();
    isolated.register(makeEntry({ name: 'skill_isolated__one' }));
    expect(singleton.has('skill_isolated__one')).toBe(false);
    expect(isolated.has('skill_singleton__one')).toBe(false);
  });
});
