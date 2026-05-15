import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-22-wikipedia-light-speed',
  instruction: 'Visit https://en.wikipedia.org/wiki/Speed_of_light and confirm the page mentions "299792458".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Speed_of_light' },
        { kind: 'dom_text', selector: 'body', contains: '299792458' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Speed-of-light article cites 299,792,458 m/s. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
