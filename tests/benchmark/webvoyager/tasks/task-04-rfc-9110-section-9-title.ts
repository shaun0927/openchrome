import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-04-rfc-9110-section-9-title',
  instruction:
    'Open RFC 9110 (HTTP Semantics) and confirm that Section 9 is titled "Methods".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://www\\.rfc-editor\\.org/rfc/rfc9110(?:\\.html|/?)' },
        { kind: 'dom_text', selector: 'body', contains: '9. Methods' },
      ],
    },
  },
  timeout_ms: 90_000,
  rationale:
    'RFCs are immutable by IETF policy once published, so this contract cannot drift. ' +
    'Tests the runner against a static text-heavy spec document.',
};

export default task;
