import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-29-wikipedia-pi',
  instruction: 'Visit https://en.wikipedia.org/wiki/Pi and confirm the page mentions "3.14".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Pi' },
        { kind: 'dom_text', selector: 'body', contains: '3.14' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Pi article cites 3.14.... Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
