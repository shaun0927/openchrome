import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-21-example-net-h1',
  instruction: 'Visit https://example.net and confirm the page mentions "Example Domain".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/example\\.net' },
        { kind: 'dom_text', selector: 'body', contains: 'Example Domain' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'h1 contains Example Domain on example.net. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
