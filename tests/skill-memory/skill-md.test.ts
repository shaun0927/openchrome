import {
  FrontmatterError,
  parseSkillMd,
  stringifySkillMd,
  validateFrontmatter,
} from '../../src/skill-memory/skill-md';
import { SKILL_SCHEMA_VERSION, type SkillFrontmatter } from '../../src/skill-memory/types';

function fm(over: Partial<SkillFrontmatter> = {}): SkillFrontmatter {
  return {
    schema_version: SKILL_SCHEMA_VERSION,
    name: 'amazon.cart-add',
    domain: 'amazon.com',
    intent: 'Add specific item to cart',
    status: 'candidate',
    verified_runs: 1,
    last_verified_at: '2026-05-08T12:00:00Z',
    contract_ref: 'txn-001',
    graph_node_anchor: 'a1b2',
    author: 'agent',
    ...over,
  };
}

describe('parseSkillMd', () => {
  test('round-trips a minimal valid SKILL.md', () => {
    const text = stringifySkillMd({ frontmatter: fm(), body: '## Steps\nClick.' });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.name).toBe('amazon.cart-add');
    expect(parsed.frontmatter.status).toBe('candidate');
    expect(parsed.body).toContain('## Steps');
  });

  test('round-trips budget under dotted-path format', () => {
    const text = stringifySkillMd({
      frontmatter: fm({ budget: { tokens_typical: 4200, wall_ms_typical: 31000 } }),
      body: '',
    });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.budget?.tokens_typical).toBe(4200);
    expect(parsed.frontmatter.budget?.wall_ms_typical).toBe(31000);
  });

  test('throws when the file does not start with `---`', () => {
    expect(() => parseSkillMd('# missing frontmatter')).toThrow(FrontmatterError);
  });

  test('throws when the closing `---` is missing', () => {
    const malformed = '---\nname: x\nstatus: candidate\n';
    expect(() => parseSkillMd(malformed)).toThrow(FrontmatterError);
  });

  test('quoted strings round-trip through colons', () => {
    const text = stringifySkillMd({
      frontmatter: fm({ intent: 'colon: in the middle' }),
      body: '',
    });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.intent).toBe('colon: in the middle');
  });

  test('comments and blank lines in frontmatter are tolerated', () => {
    const text = `---
# top comment
schema_version: 1
name: amazon.cart-add
domain: amazon.com

intent: simple
status: candidate
verified_runs: 1
last_verified_at: 2026-05-08T12:00:00Z
contract_ref: txn-001
graph_node_anchor: a1b2
author: agent
---
body here
`;
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.intent).toBe('simple');
  });
});

describe('validateFrontmatter — schema rules', () => {
  test('rejects schema_version != 1', () => {
    expect(() => validateFrontmatter({ ...fm(), schema_version: 2 })).toThrow(/schema_version/);
  });

  test('rejects illegal name', () => {
    expect(() => validateFrontmatter({ ...fm(), name: 'has spaces' })).toThrow(/name/);
    expect(() => validateFrontmatter({ ...fm(), name: 'a'.repeat(65) })).toThrow(/name/);
  });

  test('rejects intent over 512 chars', () => {
    expect(() => validateFrontmatter({ ...fm(), intent: 'x'.repeat(513) })).toThrow(/intent/);
  });

  test('rejects bad status value', () => {
    expect(() => validateFrontmatter({ ...fm(), status: 'bogus' })).toThrow(/status/);
  });

  test('rejects negative verified_runs', () => {
    expect(() => validateFrontmatter({ ...fm(), verified_runs: -1 })).toThrow(/verified_runs/);
  });

  test('rejects last_verified_at without Z suffix', () => {
    expect(() =>
      validateFrontmatter({ ...fm(), last_verified_at: '2026-05-08T12:00:00+09:00' }),
    ).toThrow(/last_verified_at/);
  });

  test('rejects non-hex graph_node_anchor', () => {
    expect(() => validateFrontmatter({ ...fm(), graph_node_anchor: 'not-hex!' })).toThrow(
      /graph_node_anchor/,
    );
  });

  test('rejects bogus author', () => {
    expect(() => validateFrontmatter({ ...fm(), author: 'admin' })).toThrow(/author/);
  });

  test('accepts every valid status', () => {
    expect(() => validateFrontmatter({ ...fm(), status: 'candidate' })).not.toThrow();
    expect(() => validateFrontmatter({ ...fm(), status: 'promoted' })).not.toThrow();
    expect(() => validateFrontmatter({ ...fm(), status: 'archived' })).not.toThrow();
  });
});
