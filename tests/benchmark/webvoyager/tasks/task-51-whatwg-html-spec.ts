import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-51-whatwg-html-spec',
  instruction: 'Visit https://html.spec.whatwg.org/ and confirm the page mentions "HTML".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/html\\.spec\\.whatwg\\.org\\/' },
        { kind: 'dom_text', selector: 'body', contains: 'HTML' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'WHATWG HTML living standard. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
