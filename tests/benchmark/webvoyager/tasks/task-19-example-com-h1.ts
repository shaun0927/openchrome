import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-19-example-com-h1',
  instruction: 'Visit https://example.com and confirm the page mentions "Example Domain".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/example\\.com' },
        { kind: 'dom_text', selector: 'body', contains: 'Example Domain' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'h1 contains Example Domain on example.com. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
