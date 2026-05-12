/// <reference types="jest" />
/**
 * Integration tests for the secrets masking layer (#834).
 *
 * Exercises:
 *  - memory.set defense-in-depth (SECRET_LITERAL_IN_VALUE)
 *  - trace redactor composition (credential-pattern + secrets value scrub)
 *  - oc_skill_record redacts step payloads before persistence
 */

import {
  makeSecretStore,
  setSecretStore,
  EMPTY_SECRET_STORE,
} from '../../../src/core/secrets/loader';
import { redactSecrets } from '../../../src/core/secrets/redactor';
import { redactValue } from '../../../src/core/trace/redactor';

const PROBE = 'hunter2_xyz_unique_string_a8f3';

describe('Trace redactor composition (#834)', () => {
  afterEach(() => setSecretStore(EMPTY_SECRET_STORE));

  test('credential-pattern redaction still works without --secrets', () => {
    // Without secrets loaded, the trace redactor still scrubs credential-
    // shaped strings via the existing regex patterns. The new compose
    // layer must not remove that behavior.
    const out = redactValue({
      headers: { authorization: 'Bearer abc123secrettoken' },
    });
    expect(JSON.stringify(out)).not.toMatch(/Bearer abc123secrettoken/);
  });

  test('with --secrets loaded, literal secret values are scrubbed too', () => {
    setSecretStore(makeSecretStore(new Map([['PW', PROBE]])));
    const out = redactValue({ note: `the password is ${PROBE}` });
    expect(JSON.stringify(out)).not.toMatch(/hunter2_xyz/);
    expect(JSON.stringify(out)).toMatch(/\$\{SECRET:PW\}/);
  });

  test('composition order: credential-pattern first, then secrets', () => {
    setSecretStore(makeSecretStore(new Map([['PW', PROBE]])));
    const out = redactValue({
      authorization: 'Bearer abc123secrettoken',
      payload: { value: PROBE },
    });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/Bearer abc123secrettoken/);
    expect(s).not.toMatch(/hunter2_xyz/);
  });
});

describe('memory.set defense-in-depth (#834)', () => {
  afterEach(() => setSecretStore(EMPTY_SECRET_STORE));

  test('findLiteralSecret returns the leaking secret name', async () => {
    // The handler-level guard lives in src/tools/memory.ts and depends on
    // findLiteralSecret. We exercise the underlying primitive here to lock
    // in the contract; the handler integration is covered via the regular
    // jest tool tests.
    setSecretStore(makeSecretStore(new Map([['PW', PROBE]])));
    const { findLiteralSecret } = await import('../../../src/core/secrets/redactor');
    expect(findLiteralSecret(`user used ${PROBE} today`)).toBe('PW');
    expect(findLiteralSecret('no secrets here')).toBeUndefined();
  });
});

describe('oc_skill_record step redaction (#834)', () => {
  afterEach(() => setSecretStore(EMPTY_SECRET_STORE));

  test('redactSecrets on step payloads removes literal values', () => {
    setSecretStore(makeSecretStore(new Map([['PW', PROBE]])));
    const steps = [
      { tool: 'form_input', args: { ref: 'r1', value: PROBE } },
      { tool: 'wait_for', args: { ms: 1000 } },
    ];
    const out = redactSecrets(steps);
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/hunter2_xyz/);
    expect(s).toMatch(/\$\{SECRET:PW\}/);
  });
});

describe('Full audit — no probe survives any artifact (#834 closure check)', () => {
  afterEach(() => setSecretStore(EMPTY_SECRET_STORE));

  test('arbitrary deeply-nested artifact never leaks the probe', () => {
    setSecretStore(makeSecretStore(new Map([['PW', PROBE]])));

    const artifact = {
      tool: 'form_input',
      response: {
        content: [{ type: 'text', text: `typed ${PROBE} into #pw` }],
      },
      trace: {
        body: { args: { value: PROBE } },
      },
      skill_step: { args: { value: PROBE } },
    };

    // Apply every redaction surface the PR adds. After these passes the
    // probe must NOT appear anywhere in the serialised artifact.
    const r1 = redactSecrets(artifact);
    const r2 = redactValue(r1);
    expect(JSON.stringify(r2)).not.toMatch(/hunter2_xyz/);
  });
});
