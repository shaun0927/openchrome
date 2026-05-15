import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-39-rfc-5321-smtp',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc5321 and confirm the page mentions "Simple Mail Transfer Protocol".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc5321' },
        { kind: 'dom_text', selector: 'body', contains: 'Simple Mail Transfer Protocol' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 5321 defines SMTP. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
