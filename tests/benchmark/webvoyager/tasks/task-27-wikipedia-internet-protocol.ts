import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-27-wikipedia-internet-protocol',
  instruction: 'Visit https://en.wikipedia.org/wiki/Internet_Protocol and confirm the page mentions "datagram".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Internet_Protocol' },
        { kind: 'dom_text', selector: 'body', contains: 'datagram' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Internet Protocol article mentions datagram. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
