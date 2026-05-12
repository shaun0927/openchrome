import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-08-mdn-array-map-return',
  instruction:
    'Open the MDN reference page for Array.prototype.map() and confirm the page ' +
    'describes the return value as "A new array with each element being the result".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://developer\\.mozilla\\.org/.+/Array/map/?$' },
        {
          kind: 'dom_text',
          selector: 'main',
          contains: 'A new array with each element being the result',
        },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN reference pages have a canonical "Return value" section whose wording has been ' +
    'stable for years. Tests deep selector matching inside the documentation main body.',
};

export default task;
