import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-41-mdn-fetch',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API and confirm the page mentions "Fetch API".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/API\\/Fetch_API' },
        { kind: 'dom_text', selector: 'body', contains: 'Fetch API' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN Fetch API reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
