import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-44-mdn-promise-then',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/then and confirm the page mentions "then".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/JavaScript\\/Reference\\/Global_Objects\\/Promise\\/then' },
        { kind: 'dom_text', selector: 'body', contains: 'then' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN Promise.prototype.then reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
