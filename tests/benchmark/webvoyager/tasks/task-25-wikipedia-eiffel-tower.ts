import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-25-wikipedia-eiffel-tower',
  instruction: 'Visit https://en.wikipedia.org/wiki/Eiffel_Tower and confirm the page mentions "Paris".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Eiffel_Tower' },
        { kind: 'dom_text', selector: 'body', contains: 'Paris' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Eiffel Tower located in Paris. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
