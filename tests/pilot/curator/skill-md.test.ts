import {
  FrontmatterError,
  parseSkillMd,
  stringifySkillMd,
  validateFrontmatter,
} from '../../../src/pilot/curator/skill-md';
import { SKILL_SCHEMA_VERSION, type SkillFrontmatter } from '../../../src/pilot/curator/types';

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

  test('multiline strings are quoted and round-trip as one frontmatter value', () => {
    const text = stringifySkillMd({
      frontmatter: fm({ intent: 'step 1\nstep 2' }),
      body: '',
    });
    expect(text).toContain('intent: "step 1\\nstep 2"');
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.intent).toBe('step 1\nstep 2');
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

describe('parseSkillMd — prototype pollution defense', () => {
  test.each([
    ['__proto__.polluted: 1'],
    ['constructor.polluted: 2'],
    ['prototype.polluted: 3'],
    ['budget.__proto__.polluted: 4'],
  ])('rejects forbidden key "%s"', (line) => {
    const text =
      '---\n' +
      'schema_version: 1\n' +
      'name: amazon.cart-add\n' +
      'domain: amazon.com\n' +
      'intent: x\n' +
      'status: candidate\n' +
      'verified_runs: 1\n' +
      'last_verified_at: 2026-05-08T12:00:00Z\n' +
      'contract_ref: txn-001\n' +
      'graph_node_anchor: a1b2\n' +
      'author: agent\n' +
      line +
      '\n---\n\nbody\n';
    expect(() => parseSkillMd(text)).toThrow(FrontmatterError);
    // Sanity: Object.prototype was not polluted as a side effect.
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseSkillMd — preserves digit-only string fields', () => {
  test('contract_ref written as digits round-trips as a string', () => {
    const text = stringifySkillMd({
      frontmatter: fm({ contract_ref: '12345' }),
      body: '',
    });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.contract_ref).toBe('12345');
    expect(typeof parsed.frontmatter.contract_ref).toBe('string');
  });

  test('graph_node_anchor with only digits round-trips as a string', () => {
    const text = stringifySkillMd({
      frontmatter: fm({ graph_node_anchor: '0123456789' }),
      body: '',
    });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.graph_node_anchor).toBe('0123456789');
    expect(typeof parsed.frontmatter.graph_node_anchor).toBe('string');
  });

  test('boolean-like string field "true" round-trips as a string (not coerced)', () => {
    // `name` is documented as a string and the NAME_PATTERN regex
    // accepts the literal token "true". Without preserving raw
    // strings, `coerce` turned this into a boolean and the next read
    // tripped `mustString`, breaking re-record for the skill.
    const text = stringifySkillMd({
      frontmatter: fm({ name: 'true' }),
      body: '',
    });
    const parsed = parseSkillMd(text);
    expect(parsed.frontmatter.name).toBe('true');
    expect(typeof parsed.frontmatter.name).toBe('string');
  });
});
