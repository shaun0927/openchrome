import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-49-tc39-ecma262-syntax',
  instruction: 'Visit https://tc39.es/ecma262/ and confirm the page mentions "ECMAScript".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/tc39\\.es\\/ecma262\\/' },
        { kind: 'dom_text', selector: 'body', contains: 'ECMAScript' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'TC39 ECMAScript spec home. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
