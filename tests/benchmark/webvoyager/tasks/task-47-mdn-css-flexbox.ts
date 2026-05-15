import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-47-mdn-css-flexbox',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout and confirm the page mentions "flex".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/CSS\\/CSS_flexible_box_layout' },
        { kind: 'dom_text', selector: 'body', contains: 'flex' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN CSS Flexbox reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
