import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-58-python-len-builtin',
  instruction: 'Visit https://docs.python.org/3/library/functions.html and confirm the page mentions "len".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/docs\\.python\\.org\\/3\\/library\\/functions\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'len' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Python built-in functions reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
