import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-20-example-org-h1',
  instruction: 'Visit https://example.org and confirm the page mentions "Example Domain".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/example\\.org' },
        { kind: 'dom_text', selector: 'body', contains: 'Example Domain' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'h1 contains Example Domain on example.org. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
