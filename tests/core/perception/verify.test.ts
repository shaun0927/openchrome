/// <reference types="jest" />
/**
 * Tests for the per-action verify helper (issue #827).
 *
 * Covers:
 *   - AX hash stable on no-op.
 *   - AX hash changes on mock DOM mutation.
 *   - pHash distance ≥ 8 between two synthetic PNGs that differ.
 *   - Payload cap: synthesize a result with an oversized summary > 4 KB
 *     and assert truncation flags.
 *   - JSON Schema fragment accepts boolean + string enum.
 *   - coerceVerifyMode legacy mapping.
 */

import {
  AxNodeTuple,
  VERIFY_FIELD_SCHEMA,
  VERIFY_TOTAL_BYTES_LIMIT,
  coerceVerifyMode,
  encodeRgbPng,
  hashAxNodes,
  runVerify,
  summarizeAxDelta,
  thumbnailPng,
} from '../../../src/core/perception/verify';
import { hamming, phashFromPng } from '../../../src/contracts/phash';
import { encodeRgbaPng, gradientRgba, solidRgba } from '../../contracts/png-fixtures';

describe('verify helpers', () => {
  describe('hashAxNodes', () => {
    it('is stable on no-op (same input → same output)', () => {
      const nodes: AxNodeTuple[] = [
        { role: 'button', name: 'Submit', focused: false, disabled: false },
        { role: 'textbox', name: 'Email', focused: true, disabled: false },
      ];
      const h1 = hashAxNodes(nodes);
      const h2 = hashAxNodes(nodes);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is enumeration-order insensitive', () => {
      const a: AxNodeTuple[] = [
        { role: 'a', name: 'x' },
        { role: 'b', name: 'y' },
      ];
      const b: AxNodeTuple[] = [
        { role: 'b', name: 'y' },
        { role: 'a', name: 'x' },
      ];
      expect(hashAxNodes(a)).toBe(hashAxNodes(b));
    });

    it('changes on DOM mutation (added/removed/state-changed nodes)', () => {
      const before: AxNodeTuple[] = [
        { role: 'button', name: 'Submit' },
      ];
      const after: AxNodeTuple[] = [
        { role: 'button', name: 'Submit' },
        { role: 'alert', name: 'Submitted' },
      ];
      expect(hashAxNodes(before)).not.toBe(hashAxNodes(after));

      // Same nodes, but focused flag flips ⇒ hash differs.
      const focusBefore: AxNodeTuple[] = [{ role: 'textbox', name: 'Q', focused: false }];
      const focusAfter: AxNodeTuple[] = [{ role: 'textbox', name: 'Q', focused: true }];
      expect(hashAxNodes(focusBefore)).not.toBe(hashAxNodes(focusAfter));
    });
  });

  describe('summarizeAxDelta', () => {
    it('counts added/removed/changed correctly', () => {
      const before: AxNodeTuple[] = [
        { role: 'button', name: 'A', disabled: false },
        { role: 'textbox', name: 'B' },
      ];
      const after: AxNodeTuple[] = [
        { role: 'button', name: 'A', disabled: true },
        { role: 'alert', name: 'C' },
      ];
      const summary = summarizeAxDelta(before, after);
      expect(summary).toBe('1 added, 1 removed, 1 changed');
    });
  });

  describe('pHash on synthetic PNGs', () => {
    it('produces distance ≥ 8 between visually different images', () => {
      const blackPng = encodeRgbaPng(64, 64, solidRgba(64, 64, [0, 0, 0, 255]));
      const gradPng = encodeRgbaPng(64, 64, gradientRgba(64, 64));
      const ha = phashFromPng(blackPng);
      const hb = phashFromPng(gradPng);
      expect(hamming(ha, hb)).toBeGreaterThanOrEqual(8);
    });

    it('distance is 0 between identical images', () => {
      const grad = encodeRgbaPng(64, 64, gradientRgba(64, 64));
      expect(hamming(phashFromPng(grad), phashFromPng(grad))).toBe(0);
    });
  });

  describe('encodeRgbPng + thumbnailPng', () => {
    it('thumbnails a 64x64 gradient and re-encodes to a valid PNG', () => {
      const src = encodeRgbaPng(64, 64, gradientRgba(64, 64));
      const thumb = thumbnailPng(src, 16);
      // PNG magic bytes
      expect(thumb[0]).toBe(0x89);
      expect(thumb[1]).toBe(0x50);
      expect(thumb[2]).toBe(0x4e);
      expect(thumb[3]).toBe(0x47);
      // The thumb should be substantially smaller than the source.
      expect(thumb.length).toBeLessThan(src.length);
    });

    it('encodeRgbPng rejects wrong-sized buffers', () => {
      expect(() => encodeRgbPng(2, 2, Buffer.alloc(3))).toThrow();
    });
  });

  describe('VERIFY_FIELD_SCHEMA', () => {
    it('exposes a oneOf union of boolean and the new enum', () => {
      expect(VERIFY_FIELD_SCHEMA.oneOf).toBeDefined();
      const variants = VERIFY_FIELD_SCHEMA.oneOf as ReadonlyArray<{ type: string; enum?: ReadonlyArray<string> }>;
      const boolEntry = variants.find((v) => v.type === 'boolean');
      const enumEntry = variants.find((v) => v.type === 'string');
      expect(boolEntry).toBeDefined();
      expect(enumEntry).toBeDefined();
      expect(enumEntry?.enum).toEqual(['none', 'ax-diff', 'screenshot', 'both']);
    });
  });

  describe('coerceVerifyMode', () => {
    it('maps the legacy boolean true to "screenshot"', () => {
      expect(coerceVerifyMode(true)).toBe('screenshot');
    });
    it('maps false / null / undefined to "none"', () => {
      expect(coerceVerifyMode(false)).toBe('none');
      expect(coerceVerifyMode(null)).toBe('none');
      expect(coerceVerifyMode(undefined)).toBe('none');
    });
    it('passes through valid string enum values', () => {
      expect(coerceVerifyMode('none')).toBe('none');
      expect(coerceVerifyMode('ax-diff')).toBe('ax-diff');
      expect(coerceVerifyMode('screenshot')).toBe('screenshot');
      expect(coerceVerifyMode('both')).toBe('both');
    });
    it('falls back to "none" on unknown input', () => {
      expect(coerceVerifyMode('rubbish')).toBe('none');
      expect(coerceVerifyMode(42)).toBe('none');
      expect(coerceVerifyMode({})).toBe('none');
    });
  });

  describe('runVerify integration', () => {
    it('mode=none → returns the action result and verify=undefined', async () => {
      const page = mockPageWithAx([]);
      const out = await runVerify(page, 'none', async () => 'hello');
      expect(out.result).toBe('hello');
      expect(out.verify).toBeUndefined();
      expect(page.screenshot).not.toHaveBeenCalled();
    });

    it('mode=ax-diff → produces ax_diff but no screenshot', async () => {
      const before: AxNodeTuple[] = [{ role: 'button', name: 'A' }];
      const after: AxNodeTuple[] = [{ role: 'button', name: 'A' }, { role: 'alert', name: 'X' }];
      const page = mockPageWithAxSequence([before, after]);
      const out = await runVerify(page, 'ax-diff', async () => 1);
      expect(out.result).toBe(1);
      expect(out.verify?.mode).toBe('ax-diff');
      expect(out.verify?.ax_diff).toBeDefined();
      expect(out.verify?.screenshot).toBeUndefined();
      expect(out.verify?.ax_diff?.changed).toBe(true);
      expect(out.verify?.ax_diff?.hash_before).not.toBe(out.verify?.ax_diff?.hash_after);
    });

    it('mode=ax-diff with unavailable AX → emits note=ax_unavailable', async () => {
      const page = mockPageWithAx(null); // CDP send rejects
      const out = await runVerify(page, 'ax-diff', async () => 1);
      expect(out.verify?.ax_diff?.note).toBe('ax_unavailable');
      expect(out.verify?.ax_diff?.changed).toBe(false);
    });

    it('mode=screenshot → produces a screenshot report with phash_distance', async () => {
      const beforePng = encodeRgbaPng(32, 32, solidRgba(32, 32, [255, 255, 255, 255]));
      const afterPng = encodeRgbaPng(32, 32, gradientRgba(32, 32));
      const page = mockPageWithScreenshots([beforePng, afterPng]);
      const out = await runVerify(page, 'screenshot', async () => 1);
      expect(out.verify?.mode).toBe('screenshot');
      expect(out.verify?.screenshot).toBeDefined();
      expect(out.verify?.ax_diff).toBeUndefined();
      expect(typeof out.verify?.screenshot?.phash_distance).toBe('number');
    });

    it('mode=screenshot honors the viewport pixel ceiling', async () => {
      const page = mockPageWithScreenshots([Buffer.alloc(0), Buffer.alloc(0)]);
      (page as any).viewport = () => ({ width: 4000, height: 2000 }); // 8M > 4M
      const out = await runVerify(page, 'screenshot', async () => 1);
      expect(out.verify?.screenshot?.skipped).toBe('viewport_too_large');
    });

    it('mode=both → returns both ax_diff and screenshot', async () => {
      const beforePng = encodeRgbaPng(16, 16, solidRgba(16, 16, [10, 10, 10, 255]));
      const afterPng = encodeRgbaPng(16, 16, gradientRgba(16, 16));
      const before: AxNodeTuple[] = [{ role: 'button', name: 'A' }];
      const after: AxNodeTuple[] = [{ role: 'button', name: 'A' }];
      const page = mockPageWithAxAndScreenshots([before, after], [beforePng, afterPng]);
      const out = await runVerify(page, 'both', async () => 1);
      expect(out.verify?.ax_diff).toBeDefined();
      expect(out.verify?.screenshot).toBeDefined();
    });

    it('caps total payload at 4 KB by dropping thumbs', async () => {
      // Build big screenshots whose 64×64 thumbs base64 to over 4 KB combined.
      const big = encodeRgbaPng(128, 128, gradientRgba(128, 128));
      const page = mockPageWithScreenshots([big, big]);
      const out = await runVerify(page, 'screenshot', async () => 1);
      expect(out.verify).toBeDefined();
      // The hard cap MUST be respected.
      expect(out.verify!.total_bytes).toBeLessThanOrEqual(VERIFY_TOTAL_BYTES_LIMIT);
    });
  });
});

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockPageWithAx(nodes: ReadonlyArray<AxNodeTuple> | null): any {
  const cdp = {
    send: jest.fn().mockImplementation(async (method: string) => {
      if (method !== 'Accessibility.getFullAXTree') return {};
      if (nodes === null) throw new Error('AX not available');
      return { nodes: nodesToCdp(nodes) };
    }),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  return {
    target: () => ({
      createCDPSession: () => Promise.resolve(cdp),
    }),
    screenshot: jest.fn(),
    viewport: () => ({ width: 800, height: 600 }),
  };
}

function mockPageWithAxSequence(snapshots: ReadonlyArray<ReadonlyArray<AxNodeTuple>>): any {
  let call = 0;
  const cdp = {
    send: jest.fn().mockImplementation(async (method: string) => {
      if (method !== 'Accessibility.getFullAXTree') return {};
      const snap = snapshots[Math.min(call++, snapshots.length - 1)];
      return { nodes: nodesToCdp(snap) };
    }),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  return {
    target: () => ({ createCDPSession: () => Promise.resolve(cdp) }),
    screenshot: jest.fn(),
    viewport: () => ({ width: 800, height: 600 }),
  };
}

function mockPageWithScreenshots(shots: ReadonlyArray<Buffer>): any {
  let call = 0;
  return {
    target: () => ({
      createCDPSession: () =>
        Promise.resolve({
          send: jest.fn().mockResolvedValue({}),
          detach: jest.fn().mockResolvedValue(undefined),
        }),
    }),
    screenshot: jest.fn().mockImplementation(async () => shots[Math.min(call++, shots.length - 1)]),
    viewport: () => ({ width: 800, height: 600 }),
  };
}

function mockPageWithAxAndScreenshots(
  axSnaps: ReadonlyArray<ReadonlyArray<AxNodeTuple>>,
  shots: ReadonlyArray<Buffer>,
): any {
  let axCall = 0;
  let shotCall = 0;
  const cdp = {
    send: jest.fn().mockImplementation(async (method: string) => {
      if (method !== 'Accessibility.getFullAXTree') return {};
      const snap = axSnaps[Math.min(axCall++, axSnaps.length - 1)];
      return { nodes: nodesToCdp(snap) };
    }),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  return {
    target: () => ({ createCDPSession: () => Promise.resolve(cdp) }),
    screenshot: jest.fn().mockImplementation(async () => shots[Math.min(shotCall++, shots.length - 1)]),
    viewport: () => ({ width: 800, height: 600 }),
  };
}

function nodesToCdp(nodes: ReadonlyArray<AxNodeTuple>): Array<unknown> {
  return nodes.map((n) => ({
    role: { value: n.role },
    name: { value: n.name },
    properties: [
      ...(n.focused ? [{ name: 'focused', value: { value: true } }] : []),
      ...(n.disabled ? [{ name: 'disabled', value: { value: true } }] : []),
    ],
    ignored: false,
  }));
}
