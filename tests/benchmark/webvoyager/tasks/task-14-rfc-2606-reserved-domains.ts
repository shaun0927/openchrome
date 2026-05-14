import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-14-rfc-2606-reserved-domains',
  instruction:
    'Open RFC 2606 on the IETF datatracker and confirm it reserves the .example top-level domain.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://datatracker\\.ietf\\.org/doc/.*rfc2606' },
        { kind: 'dom_text', selector: 'body', contains: 'Reserved Top Level DNS Names' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'RFC 2606 is a published, immutable IETF document; its title "Reserved Top Level DNS ' +
    'Names" will never change.',
};

export default task;
