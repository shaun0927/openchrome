import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-18-rfc-8259-json-title',
  instruction:
    'Open RFC 8259 on the IETF datatracker and confirm it is titled "The JavaScript Object ' +
    'Notation (JSON) Data Interchange Format".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://datatracker\\.ietf\\.org/doc/.*rfc8259' },
        {
          kind: 'dom_text',
          selector: 'body',
          contains: 'JavaScript Object Notation (JSON) Data Interchange Format',
        },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 8259 is a published, immutable IETF standard (STD 90); its title is permanent.',
};

export default task;
