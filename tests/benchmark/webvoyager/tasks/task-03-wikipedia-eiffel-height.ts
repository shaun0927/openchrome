import type { WebVoyagerTask } from '../types';

// Wikipedia infoboxes occasionally render the number-unit pair with a regular
// space and sometimes with a non-breaking space (U+00A0). We accept either via
// an `or`-of-acceptable-strings, which is a vocabulary the existing contract
// DSL already supports (no new operator).
//
// NOTE: these two constants look identical in most diff viewers — the only
// difference is the byte between "330" and "m". HEIGHT_REGULAR_SPACE uses the
// ASCII space (0x20); HEIGHT_NBSP uses U+00A0 (0xC2 0xA0 in UTF-8). The
// NBSP variant is written below with a literal U+00A0 byte between '330'
// and 'm'; in source viewers that strip the byte it looks identical to
// HEIGHT_REGULAR_SPACE — diff at the byte level to confirm.
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
