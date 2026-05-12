import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-10-tc39-ecma262-strict-mode',
  instruction:
    'Navigate to the TC39 ECMA-262 living specification root page (tc39.es/ecma262/).',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://tc39\\.es/ecma262/?' },
        { kind: 'dom_text', selector: 'body', contains: 'ECMAScript' },
      ],
    },
  },
  timeout_ms: 60_000,
  rationale:
    'Trivial reachability test for the canonical ECMAScript spec. URL prefix and ' +
    'body presence of "ECMAScript" is sufficient; the spec body changes but the ' +
    'word "ECMAScript" is structurally guaranteed.',
};

export default task;
