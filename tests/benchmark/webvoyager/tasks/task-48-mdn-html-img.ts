import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-48-mdn-html-img',
  instruction: 'Visit https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img and confirm the page mentions "img".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/developer\\.mozilla\\.org\\/en-US\\/docs\\/Web\\/HTML\\/Element\\/img' },
        { kind: 'dom_text', selector: 'body', contains: 'img' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'MDN HTML img element reference. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
