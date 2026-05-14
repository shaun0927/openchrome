import { formatHumanResult, mergeArgs, parseArgAssignments, parseArgValue, UsageError } from '../../../cli/run';

describe('oc run argument parsing (#843)', () => {
  test('parses strings and booleans', () => {
    expect(parseArgAssignments(['url=https://example.com', 'visible=true', 'dry=false'])).toEqual({
      url: 'https://example.com',
      visible: true,
      dry: false,
    });
  });

  test('parses json: values', () => {
    expect(parseArgValue('json:{"a":1,"b":[true]}')).toEqual({ a: 1, b: [true] });
  });

  test('rejects malformed assignments', () => {
    expect(() => parseArgAssignments(['missing-equals'])).toThrow(UsageError);
    expect(() => parseArgAssignments(['1bad=value'])).toThrow(UsageError);
    expect(() => parseArgAssignments(['payload=json:{bad'])).toThrow(UsageError);
  });

  test('rejects prototype-polluting argument keys', () => {
    expect(() => parseArgAssignments(['__proto__=x'])).toThrow(UsageError);
    expect(() => parseArgAssignments(['constructor.prototype=x'])).toThrow(UsageError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('explicit --arg overrides positional sugar args', () => {
    expect(mergeArgs({ url: 'https://old.example' }, { arg: ['url=https://new.example'] })).toEqual({
      url: 'https://new.example',
    });
  });

  test('formats first text item by default', () => {
    expect(formatHumanResult({ content: [{ type: 'text', text: 'hello' }], isError: false })).toBe('hello');
  });
});
