/// <reference types="jest" />
/**
 * Tests for cli/playbook/parse.ts
 */

import * as path from 'path';
import { parsePlaybookContent, loadPlaybook, ParseError, SUPPORTED_VERBS } from '../../../cli/playbook/parse';

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'playbook');

describe('parsePlaybookContent — YAML', () => {
  test('round-trips sanity.yaml fixture', () => {
    const fs = require('fs');
    const content = fs.readFileSync(path.join(FIXTURES, 'sanity.yaml'), 'utf8');
    const pb = parsePlaybookContent(content, 'sanity.yaml');
    expect(pb.name).toBe('example.com sanity');
    expect(pb.vars).toEqual({ url: 'https://example.com', heading: 'Example' });
    expect(pb.steps).toHaveLength(9);
    expect(pb.steps[0].verb).toBe('navigate');
    expect(pb.steps[0].args).toEqual({ url: '${url}' });
    expect(pb.steps[1].verb).toBe('assert');
    expect(pb.steps[1].args).toEqual({ kind: 'dom_text', selector: 'h1', pattern: '${heading}' });
  });

  test('round-trips sanity.json fixture', () => {
    const pb = parsePlaybookContent(JSON.stringify({
      name: 'example.com sanity (JSON)',
      vars: { url: 'https://example.com', heading: 'Example' },
      steps: [
        { navigate: { url: '${url}' } },
        { assert: { kind: 'dom_text', selector: 'h1', pattern: '${heading}' } },
        { interact: { query: 'More information...' } },
        { wait_for: { type: 'navigation' } },
        { assert: { kind: 'url', pattern: 'iana\\.org' } },
        { page_screenshot: { path: '/tmp/sanity.png' } },
        { read_page: { mode: 'ax' } },
        { javascript_tool: { code: 'document.title' } },
        { act: { instruction: 'scroll down' } },
      ],
    }), 'sanity.json');
    expect(pb.name).toBe('example.com sanity (JSON)');
    expect(pb.steps).toHaveLength(9);
    expect(pb.steps[0].verb).toBe('navigate');
  });

  test('accepts playbook without name and vars', () => {
    const yaml = `steps:\n  - navigate:\n      url: https://example.com\n`;
    const pb = parsePlaybookContent(yaml, 'test.yaml');
    expect(pb.name).toBeUndefined();
    expect(pb.vars).toBeUndefined();
    expect(pb.steps).toHaveLength(1);
  });

  test('accepts optional stable step ids in YAML', () => {
    const pb = parsePlaybookContent(
      `name: stable step ids
steps:
  - id: open_home
    navigate:
      url: https://example.com
  - id: verify_home
    assert:
      kind: url
      pattern: "example\\\\.com"
`,
      'step-ids.yaml',
    );

    expect(pb.steps).toEqual([
      { id: 'open_home', verb: 'navigate', args: { url: 'https://example.com' } },
      { id: 'verify_home', verb: 'assert', args: { kind: 'url', pattern: 'example\\.com' } },
    ]);
  });

  test('accepts optional stable step ids in JSON', () => {
    const pb = parsePlaybookContent(JSON.stringify({
      name: 'stable step ids (JSON)',
      steps: [
        { id: 'open_home', navigate: { url: 'https://example.com' } },
        { id: 'verify_home', assert: { kind: 'url', pattern: 'example\\.com' } },
      ],
    }), 'step-ids.json');

    expect(pb.steps.map((step) => step.id)).toEqual(['open_home', 'verify_home']);
  });

  test('accepts an id at the 64-character boundary', () => {
    const id = `a${'b'.repeat(63)}`;
    const yaml = `steps:\n  - id: ${id}\n    navigate:\n      url: https://example.com\n`;

    expect(parsePlaybookContent(yaml, 'test.yaml').steps[0].id).toBe(id);
  });

  test.each([
    ['uppercase', 'Open_home'],
    ['leading digit', '1_open_home'],
    ['Unicode', '열기'],
    ['empty', ''],
    ['too long', `a${'b'.repeat(64)}`],
  ])('rejects %s step id', (_label, id) => {
    const yaml = `steps:\n  - id: ${JSON.stringify(id)}\n    navigate:\n      url: https://example.com\n`;

    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/invalid id/i);
  });

  test('rejects non-string step id', () => {
    const yaml = `steps:\n  - id: 42\n    navigate:\n      url: https://example.com\n`;

    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/id.*string/i);
  });

  test('rejects duplicate step ids before execution', () => {
    const yaml = `steps:\n  - id: open_home\n    navigate:\n      url: https://example.com\n  - id: open_home\n    read_page:\n      mode: ax\n`;

    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/duplicate id "open_home".*step 0/i);
  });

  test('rejects unknown metadata alongside id and verb', () => {
    const yaml = `steps:\n  - id: open_home\n    description: Open the fixture\n    navigate:\n      url: https://example.com\n`;

    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/unexpected key "description"/i);
  });

  test('rejects unknown verb', () => {
    const yaml = `steps:\n  - unknown_verb:\n      foo: bar\n`;
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(ParseError);
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/unknown verb/i);
  });

  test('rejects multi-verb step', () => {
    const yaml = `steps:\n  - navigate:\n      url: https://example.com\n    interact:\n      ref: foo\n`;
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(ParseError);
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/multiple verb/i);
  });

  test('rejects missing steps array', () => {
    const yaml = `name: bad\n`;
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(ParseError);
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(/steps/i);
  });

  test('rejects non-object top level', () => {
    const yaml = `- navigate:\n    url: https://example.com\n`;
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(ParseError);
  });

  test('rejects unsupported file extension', () => {
    expect(() => parsePlaybookContent('{}', 'test.txt')).toThrow(ParseError);
    expect(() => parsePlaybookContent('{}', 'test.txt')).toThrow(/unsupported/i);
  });

  test('all 9 supported verbs are recognized', () => {
    for (const verb of SUPPORTED_VERBS) {
      const yaml = `steps:\n  - ${verb}:\n      url: https://example.com\n`;
      const pb = parsePlaybookContent(yaml, 'test.yaml');
      expect(pb.steps[0].verb).toBe(verb);
    }
  });

  test('rejects invalid YAML syntax', () => {
    const yaml = `steps:\n  - navigate:\n    url: [unclosed\n`;
    expect(() => parsePlaybookContent(yaml, 'test.yaml')).toThrow(ParseError);
  });
});

describe('loadPlaybook', () => {
  test('loads sanity.yaml from disk', () => {
    const pb = loadPlaybook(path.join(FIXTURES, 'sanity.yaml'));
    expect(pb.steps).toHaveLength(9);
  });

  test('throws ParseError for missing file', () => {
    expect(() => loadPlaybook('/nonexistent/path/playbook.yaml')).toThrow(ParseError);
  });
});
