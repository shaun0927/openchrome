import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-52-whatwg-fetch-spec',
  instruction: 'Visit https://fetch.spec.whatwg.org/ and confirm the page mentions "Fetch".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/fetch\\.spec\\.whatwg\\.org\\/' },
        { kind: 'dom_text', selector: 'body', contains: 'Fetch' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'WHATWG Fetch standard. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
