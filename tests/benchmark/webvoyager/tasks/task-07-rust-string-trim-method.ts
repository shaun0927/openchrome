import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-07-rust-string-trim-method',
  instruction:
    'On the Rust standard library docs for String, follow the link to the `trim` ' +
    'method and confirm you land on the str::trim documentation.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://doc\\.rust-lang\\.org/std/.+/str\\.html#method\\.trim$' },
        { kind: 'dom_text', selector: 'body', contains: 'trim' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Tests link-following behaviour: `String::trim` is a re-export of `str::trim`, so ' +
    'the agent must navigate the redirect. URL anchor encodes the semantic landing.',
};

export default task;
