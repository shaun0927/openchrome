/**
 * synthesizer.ts unit tests (issue #889).
 *
 * Exercises the pure schema transform — no MCP server, no filesystem.
 * Asserts:
 *   - tool name matches `^skill_[a-z0-9-]+__[a-z0-9-]+$`
 *   - parameter schema is derived from `skill.steps.parameters`
 *   - description follows the `REPLAY: <human>. Domain: <d>. Contract: <c>.` shape
 *   - missing/required validation on the input record
 */

import {
  extractSkillParameters,
  synthesizeToolDefinition,
} from '../../../src/pilot/dynamic-skills/synthesizer';
import {
  SYNTHESIZED_TOOL_NAME_PATTERN,
  isSynthesizedToolName,
  synthesizedToolName,
} from '../../../src/pilot/dynamic-skills/name';
import type { SkillRecord } from '../../../src/core/skill-memory/types';

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    skillId: 'a1b2c3d4',
    domain: 'example.com',
    name: 'login',
    steps: {
      parameters: [
        { name: 'username', type: 'string', description: 'The username', required: true },
        { name: 'password', type: 'string', description: 'The password', required: true },
      ],
      actions: [
        { kind: 'fill', selector: '#user', valueParam: 'username' },
        { kind: 'fill', selector: '#pass', valueParam: 'password' },
        { kind: 'click', selector: 'button[type=submit]' },
      ],
    },
    contractId: 'ctr_login_success',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
    ...overrides,
  };
}

describe('synthesizedToolName', () => {
  test('emits the canonical skill_<domain>__<name> shape', () => {
    expect(synthesizedToolName('example.com', 'login')).toBe('skill_example-com__login');
    expect(SYNTHESIZED_TOOL_NAME_PATTERN.test(synthesizedToolName('example.com', 'login'))).toBe(true);
  });

  test('slugifies non-alphanumeric runs into a single dash', () => {
    expect(synthesizedToolName('Sub.Foo.Co', 'Add To Cart!')).toBe('skill_sub-foo-co__add-to-cart');
  });

  test('rejects inputs that reduce to an empty slug', () => {
    expect(() => synthesizedToolName('.-.', 'login')).toThrow(/empty slug/);
    expect(() => synthesizedToolName('example.com', '!!!')).toThrow(/empty slug/);
  });

  test('isSynthesizedToolName flags only `__`-bearing names', () => {
    expect(isSynthesizedToolName('skill_a__b')).toBe(true);
    expect(isSynthesizedToolName('skill_a_b')).toBe(false);
    expect(isSynthesizedToolName('navigate')).toBe(false);
  });
});

describe('extractSkillParameters', () => {
  test('returns the documented parameter list when present', () => {
    const skill = makeSkill();
    expect(extractSkillParameters(skill.steps)).toEqual([
      { name: 'username', type: 'string', description: 'The username', required: true },
      { name: 'password', type: 'string', description: 'The password', required: true },
    ]);
  });

  test('returns an empty array when steps are malformed', () => {
    expect(extractSkillParameters(null)).toEqual([]);
    expect(extractSkillParameters('not-an-object')).toEqual([]);
    expect(extractSkillParameters({})).toEqual([]);
    expect(extractSkillParameters({ parameters: 'wrong-type' })).toEqual([]);
  });

  test('coerces unknown param types to string', () => {
    const out = extractSkillParameters({
      parameters: [{ name: 'q', type: 'date', description: 'd' }],
    });
    expect(out[0].type).toBe('string');
  });
});

describe('synthesizeToolDefinition', () => {
  test('returns a fully-formed MCPToolDefinition for a happy-path skill', () => {
    const skill = makeSkill();
    const { name, definition } = synthesizeToolDefinition(skill);
    expect(name).toBe('skill_example-com__login');
    expect(definition.name).toBe(name);
    expect(SYNTHESIZED_TOOL_NAME_PATTERN.test(definition.name)).toBe(true);
    expect(definition.description).toMatch(/^REPLAY: /);
    expect(definition.description).toContain('Domain: example.com');
    expect(definition.description).toContain('Contract: ctr_login_success');
    expect(definition.inputSchema.type).toBe('object');
    expect(definition.inputSchema.properties).toEqual({
      username: { type: 'string', description: 'The username' },
      password: { type: 'string', description: 'The password' },
    });
    expect(definition.inputSchema.required).toEqual(['username', 'password']);
  });

  test('omits `required` when no parameter is marked required', () => {
    const skill = makeSkill({
      steps: {
        parameters: [{ name: 'opt', type: 'string', description: 'optional' }],
        actions: [],
      },
    });
    const { definition } = synthesizeToolDefinition(skill);
    expect(definition.inputSchema.required).toBeUndefined();
    expect(definition.inputSchema.properties).toEqual({
      opt: { type: 'string', description: 'optional' },
    });
  });

  test('emits an empty properties bag when steps lack `parameters`', () => {
    const skill = makeSkill({ steps: { actions: [] } });
    const { definition } = synthesizeToolDefinition(skill);
    expect(definition.inputSchema.properties).toEqual({});
    expect(definition.inputSchema.required).toBeUndefined();
  });

  test('supports caller-supplied description override', () => {
    const skill = makeSkill();
    const { definition } = synthesizeToolDefinition(skill, {
      descriptionOverride: 'Log the user in via the embedded form.',
    });
    expect(definition.description).toContain('Log the user in via the embedded form.');
    expect(definition.description).toContain('Domain: example.com');
  });

  test('throws when required fields are missing', () => {
    expect(() => synthesizeToolDefinition({ ...makeSkill(), domain: '' })).toThrow(/domain/);
    expect(() => synthesizeToolDefinition({ ...makeSkill(), name: '' })).toThrow(/name/);
    expect(() => synthesizeToolDefinition({ ...makeSkill(), contractId: '' })).toThrow(/contractId/);
  });
});
