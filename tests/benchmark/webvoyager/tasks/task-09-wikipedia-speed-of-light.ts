import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-09-wikipedia-speed-of-light',
  instruction:
    'Open the English Wikipedia article on the speed of light and confirm the ' +
    'article contains the exact value 299,792,458.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://en\\.wikipedia\\.org/wiki/Speed_of_light$' },
        { kind: 'dom_text', selector: 'body', contains: '299,792,458' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Physical constant defined by the SI in 1983; the literal digit sequence cannot ' +
    'drift. Tests a long encyclopedia article.',
};

export default task;
