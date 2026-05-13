/// <reference types="jest" />
/**
 * Tests for the `fill_form` tool's #827 verify upgrade.
 *
 * Asserts the verify field schema is the shared VERIFY_FIELD_SCHEMA and the
 * legacy boolean mapping is intact. Full handler coverage stays in existing
 * fill-form/login-detector tests.
 */

import { coerceVerifyMode, VERIFY_FIELD_SCHEMA } from '../../src/core/perception/verify';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({}),
}));

describe('fill_form tool — verify field (#827)', () => {
  it('exposes the unified verify field schema', async () => {
    const tools: Map<string, { definition: any }> = new Map();
    const mockServer = {
      registerTool: (name: string, _handler: unknown, definition: any) => {
        tools.set(name, { definition });
      },
    };
    const { registerFillFormTool } = await import('../../src/tools/fill-form');
    registerFillFormTool(mockServer as unknown as Parameters<typeof registerFillFormTool>[0]);

    const def = tools.get('fill_form')!.definition;
    expect(def.inputSchema.properties.verify).toEqual(VERIFY_FIELD_SCHEMA);
  });

  describe('backcompat mapping', () => {
    it('absent ⇒ none', () => {
      expect(coerceVerifyMode(undefined)).toBe('none');
    });
    it('false ⇒ none', () => {
      expect(coerceVerifyMode(false)).toBe('none');
    });
    it('true ⇒ screenshot', () => {
      expect(coerceVerifyMode(true)).toBe('screenshot');
    });
    it('all string enum values pass through', () => {
      for (const v of ['none', 'ax-diff', 'screenshot', 'both'] as const) {
        expect(coerceVerifyMode(v)).toBe(v);
      }
    });
  });
});
