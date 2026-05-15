import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-32-wikipedia-rfc-editor',
  instruction: 'Visit https://en.wikipedia.org/wiki/Request_for_Comments and confirm the page mentions "IETF".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Request_for_Comments' },
        { kind: 'dom_text', selector: 'body', contains: 'IETF' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC document series associated with IETF. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
