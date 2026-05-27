/// <reference types="jest" />

import {
  DuplicateTemplateError,
  InvalidTemplateError,
  OutcomeTemplate,
  TemplateRegistry,
} from '../../../src/contracts/templates';

function tpl(overrides: Partial<OutcomeTemplate> = {}): OutcomeTemplate {
  return {
    id: 'public-web.page-meta',
    version: 1,
    description: 'page-level meta extraction',
    ...overrides,
  };
}

describe('TemplateRegistry', () => {
  test('empty registry: size, list, get, has are all consistent', () => {
    const r = new TemplateRegistry();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
    expect(r.get('anything')).toBeUndefined();
    expect(r.has('anything')).toBe(false);
  });

  test('register exposes a single template via get/has', () => {
    const r = new TemplateRegistry();
    const t = tpl();
    r.register(t);

    expect(r.size()).toBe(1);
    expect(r.get('public-web.page-meta')).toEqual(t);
    expect(r.get('public-web.page-meta', 1)).toEqual(t);
    expect(r.has('public-web.page-meta')).toBe(true);
    expect(r.has('public-web.page-meta', 1)).toBe(true);
    expect(r.has('public-web.page-meta', 2)).toBe(false);
  });

  test('multiple versions co-exist; unversioned get returns the highest', () => {
    const r = new TemplateRegistry();
    r.register(tpl({ version: 1, description: 'v1' }));
    r.register(tpl({ version: 3, description: 'v3' }));
    r.register(tpl({ version: 2, description: 'v2' }));

    expect(r.size()).toBe(3);
    expect(r.get('public-web.page-meta')?.version).toBe(3);
    expect(r.get('public-web.page-meta', 1)?.description).toBe('v1');
    expect(r.get('public-web.page-meta', 2)?.description).toBe('v2');
    expect(r.get('public-web.page-meta', 3)?.description).toBe('v3');
  });

  test('duplicate (id, version) throws DuplicateTemplateError', () => {
    const r = new TemplateRegistry();
    r.register(tpl());
    expect(() => r.register(tpl())).toThrow(DuplicateTemplateError);
  });

  test('rejects malformed ids', () => {
    const r = new TemplateRegistry();
    expect(() => r.register(tpl({ id: '' }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ id: 'NotKebabCase' }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ id: 'spaces not allowed' }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ id: '-leading-dash' }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ id: 'trailing-' }))).toThrow(InvalidTemplateError);
  });

  test('accepts dotted kebab-case ids', () => {
    const r = new TemplateRegistry();
    expect(() => r.register(tpl({ id: 'a' }))).not.toThrow();
    expect(() => r.register(tpl({ id: 'a-b' }))).not.toThrow();
    expect(() => r.register(tpl({ id: 'public-web.spa-hydrated' }))).not.toThrow();
    expect(() => r.register(tpl({ id: 'ns.sub.leaf' }))).not.toThrow();
  });

  test('rejects malformed version values', () => {
    const r = new TemplateRegistry();
    expect(() => r.register(tpl({ version: 0 }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ version: -1 }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ version: 1.5 }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ version: Number.NaN }))).toThrow(InvalidTemplateError);
    expect(() => r.register(tpl({ version: 'one' as unknown as number }))).toThrow(
      InvalidTemplateError,
    );
  });

  test('rejects empty descriptions', () => {
    const r = new TemplateRegistry();
    expect(() => r.register(tpl({ description: '' }))).toThrow(InvalidTemplateError);
  });

  test('list() returns ids sorted, with versions ascending and latest correct', () => {
    const r = new TemplateRegistry();
    r.register(tpl({ id: 'b.template', version: 2, description: 'b@2' }));
    r.register(tpl({ id: 'a.template', version: 1, description: 'a@1' }));
    r.register(tpl({ id: 'b.template', version: 1, description: 'b@1' }));
    r.register(tpl({ id: 'a.template', version: 5, description: 'a@5' }));

    expect(r.list()).toEqual([
      { id: 'a.template', versions: [1, 5], latest: 5, description: 'a@5' },
      { id: 'b.template', versions: [1, 2], latest: 2, description: 'b@2' },
    ]);
  });

  test('unregister(id) removes every version under that id', () => {
    const r = new TemplateRegistry();
    r.register(tpl({ version: 1 }));
    r.register(tpl({ version: 2 }));

    expect(r.unregister('public-web.page-meta')).toBe(2);
    expect(r.size()).toBe(0);
    expect(r.has('public-web.page-meta')).toBe(false);
  });

  test('unregister(id, version) removes exactly one version and keeps others', () => {
    const r = new TemplateRegistry();
    r.register(tpl({ version: 1 }));
    r.register(tpl({ version: 2 }));

    expect(r.unregister('public-web.page-meta', 1)).toBe(1);
    expect(r.size()).toBe(1);
    expect(r.has('public-web.page-meta', 1)).toBe(false);
    expect(r.has('public-web.page-meta', 2)).toBe(true);
    expect(r.get('public-web.page-meta')?.version).toBe(2);
  });

  test('unregister returns 0 for unknown id or version', () => {
    const r = new TemplateRegistry();
    expect(r.unregister('does-not-exist')).toBe(0);
    r.register(tpl({ version: 1 }));
    expect(r.unregister('public-web.page-meta', 999)).toBe(0);
    expect(r.size()).toBe(1);
  });

  test('removing the last version cleans the id slot from list()', () => {
    const r = new TemplateRegistry();
    r.register(tpl({ version: 1 }));
    expect(r.list().length).toBe(1);
    r.unregister('public-web.page-meta', 1);
    expect(r.list()).toEqual([]);
  });

  test('registered template is frozen — mutating the input does not affect the registry view', () => {
    const r = new TemplateRegistry();
    const t = tpl({ tags: ['a', 'b'] });
    r.register(t);

    // The mutation below would fail in strict mode; we wrap to assert the
    // registry's view is independent regardless of what callers do post-
    // registration.
    expect(() => {
      const got = r.get(t.id)!;
      (got as { description: string }).description = 'mutated';
    }).toThrow();
    expect(r.get(t.id)?.description).toBe('page-level meta extraction');
  });

  test('nested assertions tree is deep-frozen and cannot be mutated via registry output', () => {
    const r = new TemplateRegistry();
    const t: OutcomeTemplate = {
      id: 'public-web.deep-freeze',
      version: 1,
      description: 'deep freeze probe',
      assertions: {
        kind: 'and',
        children: [{ kind: 'no_dialog' }],
      } as unknown as OutcomeTemplate['assertions'],
      targetSchema: { format: 'schema-diff.v1', definition: { fields: ['a'] } },
      tags: ['public-web'],
    };
    r.register(t);

    const got = r.get(t.id)!;
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.assertions)).toBe(true);
    // The Assertion DSL nests via `children` / `operands`; both must be
    // deep-frozen so callers cannot reach in and mutate the tree.
    const assertions = got.assertions as { children: unknown[] };
    expect(Object.isFrozen(assertions.children)).toBe(true);
    expect(() => assertions.children.push({} as never)).toThrow();
    expect(Object.isFrozen(got.targetSchema)).toBe(true);
    expect(Object.isFrozen(got.targetSchema!.definition as object)).toBe(true);
    expect(Object.isFrozen(got.tags)).toBe(true);
    expect(() => (got.tags as string[]).push('mutated')).toThrow();
  });

  test('mutating the caller-side input after register() does not affect the stored template', () => {
    const r = new TemplateRegistry();
    const tags = ['a'];
    const definition = { fields: ['initial'] };
    const t: OutcomeTemplate = {
      id: 'public-web.aliasing-probe',
      version: 1,
      description: 'aliasing probe',
      targetSchema: { format: 'schema-diff.v1', definition },
      tags,
    };
    r.register(t);

    // Mutate the caller's references; the registry copy is a structured clone
    // so neither change should be observable through get().
    tags.push('b');
    definition.fields.push('mutated');

    const got = r.get(t.id)!;
    expect(got.tags).toEqual(['a']);
    expect((got.targetSchema!.definition as { fields: string[] }).fields).toEqual(['initial']);
  });

  test('template targetSchema and assertions pass through unchanged', () => {
    const r = new TemplateRegistry();
    const t: OutcomeTemplate = {
      id: 'public-web.page-meta',
      version: 1,
      description: 'meta',
      targetSchema: { format: 'schema-diff.v1', definition: { fields: [] } },
      assertions: { kind: 'no_dialog' },
      tags: ['public-web', 'meta'],
    };
    r.register(t);
    expect(r.get(t.id)).toEqual(t);
  });
});
