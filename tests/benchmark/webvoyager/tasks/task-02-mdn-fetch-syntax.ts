import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-02-mdn-fetch-syntax',
  instruction:
    'Open the MDN reference page for the Fetch API global `fetch()` method and ' +
    'verify the page documents the `fetch(resource)` syntax line.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://developer\\.mozilla\\.org/.+/fetch(?:_method)?/?$' },
        { kind: 'dom_text', selector: 'main', contains: 'fetch(resource)' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Tests semantic-page navigation. MDN syntax blocks are stable across minor edits; ' +
    'the contract pins on the literal signature `fetch(resource)` which has been the ' +
    'canonical form since the API stabilised.',
};

export default task;
