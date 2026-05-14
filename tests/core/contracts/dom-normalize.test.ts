/// <reference types="jest" />

import { diffDom, DomDiffEntry, normalizeDomInput } from '../../../src/core/contracts/dom-normalize';

describe('dom normalizer', () => {
  test('normalizes timestamps, generated ids, tokens, class order, and script/style content', () => {
    const a = normalizeDomInput({ html: '<html><body><div id=":r0:" class="b a" data-nonce="abc">2026-05-12T01:02:03Z<script>one()</script></div></body></html>' });
    const b = normalizeDomInput({ html: '<html><body><div id=":r1:" class="a b" data-nonce="def">2026-05-13T01:02:03Z<script>two()</script></div></body></html>' });
    expect(diffDom(a, b)).toMatchObject({ added: 0, removed: 0, modified: 0 });
  });

  test('emits simplified tag-index paths', () => {
    const before = normalizeDomInput('<html><body><div><button>Old</button></div></body></html>');
    const after = normalizeDomInput('<html><body><div><button>New</button><button>More</button></div></body></html>');
    const diff = diffDom(before, after);
    const paths = diff.entries.map((entry: DomDiffEntry) => entry.path);
    expect(diff.modified).toBe(1);
    expect(diff.added).toBe(1);
    expect(paths).toContain('/html[1]/body[1]/div[1]/button[1]');
    expect(paths).toContain('/html[1]/body[1]/div[1]/button[2]');
  });
});
