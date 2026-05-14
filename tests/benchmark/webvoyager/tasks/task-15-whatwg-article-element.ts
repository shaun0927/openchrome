import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-15-whatwg-article-element',
  instruction:
    'Open the WHATWG HTML Living Standard section on the <article> element and confirm ' +
    'it describes a complete, self-contained composition.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://html\\.spec\\.whatwg\\.org/.*sections.*' },
        { kind: 'dom_text', selector: 'body', contains: 'self-contained composition' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'WHATWG Living Standard. The normative description of <article> as a "self-contained ' +
    'composition" is long-standing canonical text.',
};

export default task;
