/// <reference types="jest" />
/**
 * Tests for cli/playbook/vars.ts
 */

import {
  buildVarMap,
  substituteString,
  substituteValue,
  parseCliVars,
  VarError,
} from '../../../cli/playbook/vars';

describe('buildVarMap', () => {
  test('merges playbook vars and CLI vars', () => {
    const result = buildVarMap({ url: 'https://example.com', heading: 'Hello' }, { heading: 'World' });
    expect(result).toEqual({ url: 'https://example.com', heading: 'World' });
  });

  test('CLI vars override playbook vars', () => {
    const result = buildVarMap({ url: 'orig' }, { url: 'override' });
    expect(result.url).toBe('override');
  });

  test('handles undefined playbookVars', () => {
    const result = buildVarMap(undefined, { url: 'https://example.com' });
    expect(result).toEqual({ url: 'https://example.com' });
  });
});

describe('substituteString', () => {
  const varMap = { url: 'https://example.com', heading: 'World' };

  test('substitutes a single variable', () => {
    expect(substituteString('${url}', varMap)).toBe('https://example.com');
  });

  test('substitutes multiple variables', () => {
    expect(substituteString('Visit ${url} and say ${heading}', varMap)).toBe(
      'Visit https://example.com and say World',
    );
  });

  test('returns string unchanged when no vars present', () => {
    expect(substituteString('no vars here', varMap)).toBe('no vars here');
  });

  test('throws VarError for unknown variable', () => {
    expect(() => substituteString('${unknown}', varMap)).toThrow(VarError);
    expect(() => substituteString('${unknown}', varMap)).toThrow(/unknown/i);
  });

  test('throws VarError and includes step index in message', () => {
    try {
      substituteString('${missing}', varMap, 3);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VarError);
      const varErr = err as VarError;
      expect(varErr.stepIndex).toBe(3);
      expect(varErr.message).toContain('step 3');
    }
  });

  test('SECRET: namespace emits warning and resolves from varMap', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const map = { 'SECRET:MY_TOKEN': 'secret-value' };
    const result = substituteString('${SECRET:MY_TOKEN}', map);
    expect(result).toBe('secret-value');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('SECRET:MY_TOKEN'));
    stderrSpy.mockRestore();
  });

  test('SECRET: namespace with missing var throws VarError with warning', () => {
    const stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => substituteString('${SECRET:MISSING}', {})).toThrow(VarError);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('SECRET:MISSING'));
    stderrSpy.mockRestore();
  });
});

describe('substituteValue', () => {
  const varMap = { base: 'https://example.com' };

  test('substitutes in a flat object', () => {
    const result = substituteValue({ url: '${base}/path' }, varMap);
    expect(result).toEqual({ url: 'https://example.com/path' });
  });

  test('substitutes in nested object', () => {
    const result = substituteValue({ a: { b: '${base}' } }, varMap);
    expect(result).toEqual({ a: { b: 'https://example.com' } });
  });

  test('substitutes in arrays', () => {
    const result = substituteValue(['${base}', 'literal'], varMap);
    expect(result).toEqual(['https://example.com', 'literal']);
  });

  test('passes through non-string values unchanged', () => {
    const result = substituteValue({ count: 42, flag: true, nil: null }, varMap);
    expect(result).toEqual({ count: 42, flag: true, nil: null });
  });
});

describe('parseCliVars', () => {
  test('parses KEY=VALUE entries', () => {
    expect(parseCliVars(['url=https://example.com', 'name=Alice'])).toEqual({
      url: 'https://example.com',
      name: 'Alice',
    });
  });

  test('handles value with = sign', () => {
    expect(parseCliVars(['expr=a=b'])).toEqual({ expr: 'a=b' });
  });

  test('handles empty array', () => {
    expect(parseCliVars([])).toEqual({});
  });

  test('throws VarError for missing = sign', () => {
    expect(() => parseCliVars(['noequals'])).toThrow(VarError);
    expect(() => parseCliVars(['noequals'])).toThrow(/KEY=VALUE/i);
  });
});
