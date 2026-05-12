import type { WebVoyagerTask } from '../types';

// Wikipedia infoboxes occasionally render the number-unit pair with a regular
// space and sometimes with a non-breaking space (U+00A0). We accept either via
// an `or`-of-acceptable-strings, which is a vocabulary the existing contract
// DSL already supports (no new operator).
const HEIGHT_REGULAR_SPACE = '330 m';
const HEIGHT_NBSP = '330 m';

const task: WebVoyagerTask = {
  name: 'task-03-wikipedia-eiffel-height',
  instruction:
    'Open the English Wikipedia article for the Eiffel Tower and verify the article ' +
    'mentions the height "330 m".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://en\\.wikipedia\\.org/wiki/Eiffel_Tower$' },
        {
          kind: 'or',
          children: [
            { kind: 'dom_text', selector: 'body', contains: HEIGHT_REGULAR_SPACE },
            { kind: 'dom_text', selector: 'body', contains: HEIGHT_NBSP },
          ],
        },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Encyclopedia entry; physical fact that does not change. `or` allows for the ' +
    'non-breaking-space variant Wikipedia frequently uses in infoboxes without ' +
    'introducing a new operator.',
};

export default task;
