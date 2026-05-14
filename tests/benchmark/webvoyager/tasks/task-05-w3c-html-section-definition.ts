import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-05-w3c-html-section-definition',
  instruction:
    'Open the WHATWG HTML Living Standard page for the <section> element and confirm ' +
    'the description begins "represents a generic section".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://html\\.spec\\.whatwg\\.org/.*sections.*' },
        { kind: 'dom_text', selector: 'body', contains: 'represents a generic section' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'WHATWG Living Standard. The phrase "represents a generic section" has been the ' +
    'canonical normative description for <section> since the spec was written.',
};

export default task;
