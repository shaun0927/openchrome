import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-35-rfc-8259-json',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc8259 and confirm the page mentions "JavaScript Object Notation".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc8259' },
        { kind: 'dom_text', selector: 'body', contains: 'JavaScript Object Notation' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 8259 titled JavaScript Object Notation. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
