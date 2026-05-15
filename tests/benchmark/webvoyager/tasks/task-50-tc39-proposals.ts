import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-50-tc39-proposals',
  instruction: 'Visit https://github.com/tc39/proposals and confirm the page mentions "proposals".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/github\\.com\\/tc39\\/proposals' },
        { kind: 'dom_text', selector: 'body', contains: 'proposals' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'TC39 proposals repo. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
