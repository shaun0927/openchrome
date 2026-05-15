import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-30-wikipedia-utf8',
  instruction: 'Visit https://en.wikipedia.org/wiki/UTF-8 and confirm the page mentions "variable-width".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/UTF-8' },
        { kind: 'dom_text', selector: 'body', contains: 'variable-width' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'UTF-8 described as variable-width. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
