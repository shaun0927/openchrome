import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-43-mdn-array-filter',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter and confirm the page mentions "filter".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/JavaScript\\/Reference\\/Global_Objects\\/Array\\/filter' },
        { kind: 'dom_text', selector: 'body', contains: 'filter' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN Array.prototype.filter reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
