import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-28-wikipedia-ascii',
  instruction: 'Visit https://en.wikipedia.org/wiki/ASCII and confirm the page mentions "128".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/ASCII' },
        { kind: 'dom_text', selector: 'body', contains: '128' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'ASCII character set described as 128 code points. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
