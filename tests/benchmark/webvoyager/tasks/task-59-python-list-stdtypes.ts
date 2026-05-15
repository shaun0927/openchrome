import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-59-python-list-stdtypes',
  instruction: 'Visit https://docs.python.org/3/library/stdtypes.html and confirm the page mentions "list".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/docs\\.python\\.org\\/3\\/library\\/stdtypes\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'list' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Python stdtypes reference (list). Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
