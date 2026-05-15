import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-12-wikipedia-everest-height',
  instruction:
    'Open the Wikipedia article for Mount Everest and confirm its elevation is listed as 8,849 metres.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://en\\.wikipedia\\.org/wiki/Mount_Everest$' },
        { kind: 'dom_text', selector: 'body', contains: '8,849' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Mount Everest\'s official elevation (8,849 m, the 2020 China-Nepal joint survey) is a ' +
    'stable, sourced fact in the article infobox and lead.',
};

export default task;
