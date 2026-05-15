import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-42-mdn-array-map',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map and confirm the page mentions "map".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/JavaScript\\/Reference\\/Global_Objects\\/Array\\/map' },
        { kind: 'dom_text', selector: 'body', contains: 'map' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN Array.prototype.map reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
