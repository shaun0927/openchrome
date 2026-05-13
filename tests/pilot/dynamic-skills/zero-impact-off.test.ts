/**
 * Portability-Harness Contract P2 enforcement (issue #889).
 *
 * Verifies that the dynamic-skills family defaults to OFF, including when
 * `--pilot` is set. The other pilot families default to ON inside `--pilot`;
 * dynamic-skills is the deliberate exception because it mutates the MCP tool
 * surface mid-session.
 *
 * Three states must hold:
 *
 *   | OPENCHROME_PILOT | OPENCHROME_DYNAMIC_SKILLS | isDynamicSkillsEnabled() |
 *   | ---------------- | ------------------------- | ------------------------ |
 *   | unset            | unset                     | false                    |
 *   | unset            | 1                         | false                    |
 *   | 1                | unset                     | false  ← P2 invariant    |
 *   | 1                | 1                         | true                     |
 *
 * If the middle row flips to `true`, every existing v1.11.0 pilot user starts
 * synthesizing tools on navigate without opting in — a P2 violation.
 */

describe('dynamic-skills zero-impact-when-off (P2 invariant)', () => {
  const originalPilot = process.env.OPENCHROME_PILOT;
  const originalDynamic = process.env.OPENCHROME_DYNAMIC_SKILLS;

  afterEach(() => {
    if (originalPilot === undefined) delete process.env.OPENCHROME_PILOT;
    else process.env.OPENCHROME_PILOT = originalPilot;
    if (originalDynamic === undefined) delete process.env.OPENCHROME_DYNAMIC_SKILLS;
    else process.env.OPENCHROME_DYNAMIC_SKILLS = originalDynamic;
  });

  test('both env vars unset → off', () => {
    delete process.env.OPENCHROME_PILOT;
    delete process.env.OPENCHROME_DYNAMIC_SKILLS;
    jest.resetModules();
    const { isDynamicSkillsEnabled } = require('../../../src/harness/flags');
    expect(isDynamicSkillsEnabled()).toBe(false);
  });

  test('only OPENCHROME_DYNAMIC_SKILLS=1 (no --pilot) → off', () => {
    delete process.env.OPENCHROME_PILOT;
    process.env.OPENCHROME_DYNAMIC_SKILLS = '1';
    jest.resetModules();
    const { isDynamicSkillsEnabled } = require('../../../src/harness/flags');
    expect(isDynamicSkillsEnabled()).toBe(false);
  });

  test('only --pilot (no OPENCHROME_DYNAMIC_SKILLS) → off  ← THE invariant', () => {
    process.env.OPENCHROME_PILOT = '1';
    delete process.env.OPENCHROME_DYNAMIC_SKILLS;
    jest.resetModules();
    const { isDynamicSkillsEnabled } = require('../../../src/harness/flags');
    expect(isDynamicSkillsEnabled()).toBe(false);
  });

  test('both set → on', () => {
    process.env.OPENCHROME_PILOT = '1';
    process.env.OPENCHROME_DYNAMIC_SKILLS = '1';
    jest.resetModules();
    const { isDynamicSkillsEnabled } = require('../../../src/harness/flags');
    expect(isDynamicSkillsEnabled()).toBe(true);
  });

  test('tool name regex protects against handwritten collisions', () => {
    const { isSynthesizedToolName } = require('../../../src/pilot/dynamic-skills/name');
    // Synthesized names use a `__` separator; handwritten tools never do.
    expect(isSynthesizedToolName('skill_example-com__login')).toBe(true);
    expect(isSynthesizedToolName('navigate')).toBe(false);
    expect(isSynthesizedToolName('oc_skill_recall')).toBe(false);
    expect(isSynthesizedToolName('extract_data')).toBe(false);
  });
});
