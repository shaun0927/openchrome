import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-53-w3c-css-spec',
  instruction: 'Visit https://www.w3.org/Style/CSS/ and confirm the page mentions "CSS".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/www\\.w3\\.org\\/Style\\/CSS\\/' },
        { kind: 'dom_text', selector: 'body', contains: 'CSS' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'W3C CSS home. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
