import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-13-mdn-array-length',
  instruction:
    'Open the MDN reference for Array.prototype.length and confirm it describes the ' +
    'number of elements in the array.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        {
          kind: 'url',
          pattern: '^https://developer\\.mozilla\\.org/.*Array/length',
        },
        { kind: 'dom_text', selector: 'body', contains: 'number of elements in that array' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN reference page. The normative description of Array.prototype.length has been ' +
    'stable for years and the page is a long-lived canonical URL.',
};

export default task;
