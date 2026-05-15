import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-45-mdn-async-await',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await and confirm the page mentions "await".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/JavaScript\\/Reference\\/Operators\\/await' },
        { kind: 'dom_text', selector: 'body', contains: 'await' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN await operator reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
