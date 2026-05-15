import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-36-rfc-9110-http',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc9110 and confirm the page mentions "HTTP Semantics".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc9110' },
        { kind: 'dom_text', selector: 'body', contains: 'HTTP Semantics' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 9110 titled HTTP Semantics. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
