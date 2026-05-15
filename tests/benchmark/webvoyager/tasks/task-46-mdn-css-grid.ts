import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-46-mdn-css-grid',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout and confirm the page mentions "grid".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/CSS\\/CSS_grid_layout' },
        { kind: 'dom_text', selector: 'body', contains: 'grid' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN CSS Grid Layout reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
