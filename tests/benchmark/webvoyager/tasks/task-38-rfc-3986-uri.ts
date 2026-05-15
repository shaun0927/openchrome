import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-38-rfc-3986-uri',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc3986 and confirm the page mentions "Uniform Resource Identifier".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc3986' },
        { kind: 'dom_text', selector: 'body', contains: 'Uniform Resource Identifier' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 3986 defines URI syntax. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
