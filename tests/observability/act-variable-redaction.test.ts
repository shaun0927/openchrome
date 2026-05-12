/// <reference types="jest" />

import { redactArgs } from '../../src/observability/redaction';

describe('act variable redaction', () => {
  test('redacts all act variable values in audit args', () => {
    const { redacted } = redactArgs('act', {
      instruction: 'type %username% and %password%',
      variables: {
        username: 'alice@example.com',
        password: 'S3cret-Value-Do-Not-Log',
      },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('S3cret-Value-Do-Not-Log');
    expect(redacted.variables).toEqual({ username: '[REDACTED]', password: '[REDACTED]' });
  });
});
