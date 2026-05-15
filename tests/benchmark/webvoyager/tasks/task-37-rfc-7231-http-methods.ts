import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-37-rfc-7231-http-methods',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc7231 and confirm the page mentions "method".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc7231' },
        { kind: 'dom_text', selector: 'body', contains: 'method' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 7231 defines HTTP methods. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
