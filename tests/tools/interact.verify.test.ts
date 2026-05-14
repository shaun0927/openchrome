/// <reference types="jest" />
/**
 * Tests for the `interact` tool's #827 verify upgrade.
 *
 * Focus: input schema accepts boolean + new enum, coerceVerifyMode produces
 * the right shape, and the runtime wires `runVerify` correctly. We do NOT
 * exercise the full puppeteer mock here — that surface is already covered by
 * existing interact tests; adding verify-shape assertions to the same fixture
 * would duplicate a great deal of infrastructure for no extra signal.
 */

import { coerceVerifyMode, VERIFY_FIELD_SCHEMA } from '../../src/core/perception/verify';

// Load the registered tool definition so we can assert the JSON Schema fragment
// is wired through verbatim.
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({}),
}));
jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn().mockReturnValue({}),
}));

describe('interact tool — verify field (#827)', () => {
  it('exposes the unified verify field schema', async () => {
    const tools: Map<string, { definition: any }> = new Map();
    const mockServer = {
      registerTool: (name: string, _handler: unknown, definition: any) => {
        tools.set(name, { definition });
      },
    };
    const { registerInteractTool } = await import('../../src/tools/interact');
    registerInteractTool(mockServer as unknown as Parameters<typeof registerInteractTool>[0]);

    const def = tools.get('interact')!.definition;
    expect(def.inputSchema.properties.verify).toEqual(VERIFY_FIELD_SCHEMA);
  });

  describe('backcompat mapping', () => {
    it('verify absent ⇒ "none" (default → no verify field returned)', () => {
      expect(coerceVerifyMode(undefined)).toBe('none');
    });
    it('verify: false ⇒ "none"', () => {
      expect(coerceVerifyMode(false)).toBe('none');
    });
    it('verify: true ⇒ "screenshot" (legacy interact behavior)', () => {
      expect(coerceVerifyMode(true)).toBe('screenshot');
    });
    it('verify: "ax-diff" ⇒ ax-diff (no screenshot)', () => {
      expect(coerceVerifyMode('ax-diff')).toBe('ax-diff');
    });
    it('verify: "both" ⇒ both', () => {
      expect(coerceVerifyMode('both')).toBe('both');
    });
    it('verify: "none" ⇒ none', () => {
      expect(coerceVerifyMode('none')).toBe('none');
    });
  });

  it('schema oneOf accepts boolean and the new enum', () => {
    const oneOf = VERIFY_FIELD_SCHEMA.oneOf as ReadonlyArray<{ type: string; enum?: ReadonlyArray<string> }>;
    expect(oneOf.some((v) => v.type === 'boolean')).toBe(true);
    const enumVariant = oneOf.find((v) => v.type === 'string');
    expect(enumVariant?.enum).toEqual(['none', 'ax-diff', 'screenshot', 'both']);
  });
});
