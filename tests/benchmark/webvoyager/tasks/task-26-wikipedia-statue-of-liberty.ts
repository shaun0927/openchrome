import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-26-wikipedia-statue-of-liberty',
  instruction: 'Visit https://en.wikipedia.org/wiki/Statue_of_Liberty and confirm the page mentions "New York".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Statue_of_Liberty' },
        { kind: 'dom_text', selector: 'body', contains: 'New York' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Statue of Liberty located in New York. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
