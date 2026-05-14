import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-17-python-len-builtin',
  instruction:
    'Open the Python documentation for the built-in len() function and confirm it returns ' +
    'the length (the number of items) of an object.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://docs\\.python\\.org/3/library/functions\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'the number of items of an object' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Python docs. The wording of the len() builtin description is long-stable and the ' +
    'functions.html reference URL is canonical.',
};

export default task;
