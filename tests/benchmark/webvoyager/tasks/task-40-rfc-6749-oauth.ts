import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-40-rfc-6749-oauth',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc6749 and confirm the page mentions "OAuth 2.0".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc6749' },
        { kind: 'dom_text', selector: 'body', contains: 'OAuth 2.0' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 6749 defines OAuth 2.0. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
