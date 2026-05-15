import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-31-wikipedia-tim-berners-lee',
  instruction: 'Visit https://en.wikipedia.org/wiki/Tim_Berners-Lee and confirm the page mentions "World Wide Web".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Tim_Berners-Lee' },
        { kind: 'dom_text', selector: 'body', contains: 'World Wide Web' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Tim Berners-Lee credited with inventing the World Wide Web. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
