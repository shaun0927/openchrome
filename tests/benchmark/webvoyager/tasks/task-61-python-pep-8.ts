import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-61-python-pep-8',
  instruction: 'Visit https://peps.python.org/pep-0008/ and confirm the page mentions "Style Guide".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/peps\\.python\\.org\\/pep-0008\\/' },
        { kind: 'dom_text', selector: 'body', contains: 'Style Guide' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'PEP 8 Style Guide. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
