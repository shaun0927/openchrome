/// <reference types="jest" />

import { REDACTED, redactPredicateSource, redactValue } from '../../../src/core/trace/redactor';

describe('wait_for predicate redaction', () => {
  test('redacts cookie-bearing predicate literals', () => {
    const source = "document.cookie.includes('SESSIONID=abc123xyz')";
    const redacted = redactPredicateSource(source);
    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain('SESSIONID=abc123xyz');
  });

  test('redacts wait_for function value inside trace-like tool event args', () => {
    const event = {
      tool: 'wait_for',
      args: {
        tabId: 'tab-1',
        type: 'function',
        value: "document.cookie.includes('SESSIONID=abc123xyz')",
      },
    };

    const redacted = redactValue(event) as typeof event;
    expect(redacted.args.value).toContain(REDACTED);
    expect(JSON.stringify(redacted)).not.toContain('SESSIONID=abc123xyz');
  });
});
