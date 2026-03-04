/// <reference types="jest" />
import { validateToolSchema } from '../../src/utils/schema-validator';

describe('validateToolSchema', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // Helper to build a minimal valid inputSchema
  function makeSchema(
    properties: Record<string, unknown> = {},
    required?: string[]
  ) {
    return { type: 'object' as const, properties, required };
  }

  // 1. Valid schemas produce no warnings
  describe('valid schemas', () => {
    it('does not warn for an empty schema', () => {
      validateToolSchema('tool', makeSchema());
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not warn for a simple string property with no enum', () => {
      validateToolSchema('tool', makeSchema({ action: { type: 'string', description: 'An action' } }));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not warn for a string enum with valid values', () => {
      validateToolSchema('tool', makeSchema({
        color: { type: 'string', enum: ['red', 'green', 'blue'] }
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not warn when required fields are all present in properties', () => {
      validateToolSchema('tool', makeSchema(
        { url: { type: 'string' }, timeout: { type: 'number' } },
        ['url', 'timeout']
      ));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 2. enum on non-string type triggers warning
  describe('enum on non-string type', () => {
    it('warns when enum is on a number-typed property', () => {
      validateToolSchema('my-tool', makeSchema({
        count: { type: 'number', enum: [1, 2, 3] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OpenChrome] Schema warning for tool "my-tool"')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('enum')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Gemini')
      );
    });

    it('warns when enum is on a boolean-typed property', () => {
      validateToolSchema('tool', makeSchema({
        flag: { type: 'boolean', enum: [true, false] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"flag"')
      );
    });

    it('does not warn when enum is on a string-typed property', () => {
      validateToolSchema('tool', makeSchema({
        mode: { type: 'string', enum: ['fast', 'slow'] }
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 3. Empty string in enum triggers warning
  describe('empty string in enum', () => {
    it('warns when enum contains an empty string', () => {
      validateToolSchema('tool', makeSchema({
        status: { type: 'string', enum: ['active', '', 'inactive'] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty string')
      );
    });

    it('warns when enum is exactly [""]', () => {
      validateToolSchema('tool', makeSchema({
        val: { type: 'string', enum: [''] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty string')
      );
    });

    it('does not warn when enum has no empty strings', () => {
      validateToolSchema('tool', makeSchema({
        status: { type: 'string', enum: ['active', 'inactive'] }
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 4. Empty enum array triggers warning
  describe('empty enum array', () => {
    it('warns when enum is an empty array', () => {
      validateToolSchema('tool', makeSchema({
        choice: { type: 'string', enum: [] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('empty "enum" array')
      );
    });

    it('does not warn when enum has at least one value', () => {
      validateToolSchema('tool', makeSchema({
        choice: { type: 'string', enum: ['a'] }
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 5. required items must exist in properties
  describe('required fields not in properties', () => {
    it('warns when a required field is missing from properties', () => {
      validateToolSchema('tool', makeSchema(
        { url: { type: 'string' } },
        ['url', 'missingField']
      ));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"missingField"')
      );
    });

    it('warns for all missing required fields', () => {
      validateToolSchema('tool', makeSchema(
        {},
        ['fieldA', 'fieldB']
      ));
      const calls = errorSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.some(c => c.includes('"fieldA"'))).toBe(true);
      expect(calls.some(c => c.includes('"fieldB"'))).toBe(true);
    });

    it('does not warn when all required fields are present', () => {
      validateToolSchema('tool', makeSchema(
        { url: { type: 'string' } },
        ['url']
      ));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 6. oneOf/anyOf/allOf in property triggers warning
  describe('oneOf/anyOf/allOf at property level', () => {
    it('warns when a property uses oneOf', () => {
      validateToolSchema('tool', makeSchema({
        value: { oneOf: [{ type: 'string' }, { type: 'number' }] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"oneOf"')
      );
    });

    it('warns when a property uses anyOf', () => {
      validateToolSchema('tool', makeSchema({
        value: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"anyOf"')
      );
    });

    it('warns when a property uses allOf', () => {
      validateToolSchema('tool', makeSchema({
        value: { allOf: [{ type: 'string' }, { minLength: 1 }] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"allOf"')
      );
    });

    it('does not warn for a property without oneOf/anyOf/allOf', () => {
      validateToolSchema('tool', makeSchema({
        value: { type: 'string' }
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 7. Nested object properties are also validated
  describe('nested object property validation', () => {
    it('warns for enum issues in nested properties', () => {
      validateToolSchema('tool', makeSchema({
        config: {
          type: 'object',
          properties: {
            level: { type: 'number', enum: [1, 2, 3] }
          }
        }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('config.level')
      );
    });

    it('warns for empty string in enum in nested properties', () => {
      validateToolSchema('tool', makeSchema({
        opts: {
          type: 'object',
          properties: {
            tag: { type: 'string', enum: ['', 'foo'] }
          }
        }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('opts.tag')
      );
    });

    it('warns for oneOf in deeply nested property', () => {
      validateToolSchema('tool', makeSchema({
        outer: {
          type: 'object',
          properties: {
            inner: { oneOf: [{ type: 'string' }, { type: 'number' }] }
          }
        }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('outer.inner')
      );
    });

    it('does not warn for a valid nested schema', () => {
      validateToolSchema('tool', makeSchema({
        config: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['fast', 'slow'] }
          }
        }
      }));
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // 8. Function does NOT throw
  describe('function does not throw', () => {
    it('does not throw for a schema with multiple issues', () => {
      expect(() => {
        validateToolSchema('tool', makeSchema({
          count: { type: 'number', enum: [] },
          mode: { anyOf: [{ type: 'string' }] }
        }, ['missingField']));
      }).not.toThrow();
    });

    it('does not throw for a completely empty schema', () => {
      expect(() => {
        validateToolSchema('tool', { type: 'object', properties: {} });
      }).not.toThrow();
    });

    it('does not throw when required is undefined', () => {
      expect(() => {
        validateToolSchema('tool', { type: 'object', properties: { x: { type: 'string' } } });
      }).not.toThrow();
    });
  });

  // 9. Warning message format
  describe('warning message format', () => {
    it('includes tool name in the warning', () => {
      validateToolSchema('my-special-tool', makeSchema({
        val: { type: 'string', enum: [] }
      }));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OpenChrome] Schema warning for tool "my-special-tool"')
      );
    });
  });
});
