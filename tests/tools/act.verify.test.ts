/// <reference types="jest" />
/**
 * Tests for the `act` tool's #827 verify upgrade.
 *
 * Asserts the schema is the shared VERIFY_FIELD_SCHEMA and the legacy boolean
 * mapping is intact. The full handler is covered by existing act.test.ts.
 */

import { coerceVerifyMode, VERIFY_FIELD_SCHEMA } from '../../src/core/perception/verify';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn().mockReturnValue({}),
}));
jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn().mockReturnValue({}),
}));

describe('act tool — verify field (#827)', () => {
  it('exposes the unified verify field schema', async () => {
    const tools: Map<string, { definition: any }> = new Map();
    const mockServer = {
      registerTool: (name: string, _handler: unknown, definition: any) => {
        tools.set(name, { definition });
      },
    };
    const { registerActTool } = await import('../../src/tools/act');
    registerActTool(mockServer as unknown as Parameters<typeof registerActTool>[0]);

    const def = tools.get('act')!.definition;
    expect(def.inputSchema.properties.verify).toEqual(VERIFY_FIELD_SCHEMA);
  });

  describe('backcompat mapping (legacy act `verify: boolean`)', () => {
    it('absent / true / false legacy values resolve correctly', () => {
      expect(coerceVerifyMode(undefined)).toBe('none');
      expect(coerceVerifyMode(true)).toBe('screenshot');
      expect(coerceVerifyMode(false)).toBe('none');
    });
    it('new enum values pass through', () => {
      expect(coerceVerifyMode('ax-diff')).toBe('ax-diff');
      expect(coerceVerifyMode('both')).toBe('both');
      expect(coerceVerifyMode('screenshot')).toBe('screenshot');
      expect(coerceVerifyMode('none')).toBe('none');
    });
  });
});
