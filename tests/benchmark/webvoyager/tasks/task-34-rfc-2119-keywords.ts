import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-34-rfc-2119-keywords',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc2119 and confirm the page mentions "MUST".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc2119' },
        { kind: 'dom_text', selector: 'body', contains: 'MUST' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 2119 defines MUST keyword. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
