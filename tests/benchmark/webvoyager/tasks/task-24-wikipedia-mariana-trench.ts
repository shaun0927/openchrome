import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-24-wikipedia-mariana-trench',
  instruction: 'Visit https://en.wikipedia.org/wiki/Mariana_Trench and confirm the page mentions "deepest".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Mariana_Trench' },
        { kind: 'dom_text', selector: 'body', contains: 'deepest' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Mariana Trench described as deepest oceanic trench. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
