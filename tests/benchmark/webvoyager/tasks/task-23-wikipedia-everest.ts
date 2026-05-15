import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-23-wikipedia-everest',
  instruction: 'Visit https://en.wikipedia.org/wiki/Mount_Everest and confirm the page mentions "8,848".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Mount_Everest' },
        { kind: 'dom_text', selector: 'body', contains: '8,848' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Mount Everest height cited as 8,848 m. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
