import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-33-rfc-2606-reserved',
  instruction: 'Visit https://www.rfc-editor.org/rfc/rfc2606 and confirm the page mentions "example".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.rfc-editor\\.org\\/rfc\\/rfc2606' },
        { kind: 'dom_text', selector: 'body', contains: 'example' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 2606 lists example as a reserved TLD. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
