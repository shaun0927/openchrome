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
    const fs = require('fs');
    const content = fs.readFileSync(path.join(FIXTURES, 'sanity.json'), 'utf8');
    const pb = parsePlaybookContent(content, 'sanity.json');
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

  test('loads sanity.json from disk', () => {
    const pb = loadPlaybook(path.join(FIXTURES, 'sanity.json'));
    expect(pb.steps).toHaveLength(9);
  });

  test('throws ParseError for missing file', () => {
    expect(() => loadPlaybook('/nonexistent/path/playbook.yaml')).toThrow(ParseError);
  });
});
