/**
 * Unit tests for the wrapInIIFE helper in javascript.ts.
 */

import { wrapInIIFE } from '../../src/tools/javascript';

describe('wrapInIIFE', () => {
  // --- simple expressions — must NOT be wrapped ---

  test('simple property access stays unwrapped', () => {
    expect(wrapInIIFE('document.title')).toBe('document.title');
  });

  test('arithmetic expression stays unwrapped', () => {
    expect(wrapInIIFE('1 + 2')).toBe('1 + 2');
  });

  test('function call without semicolon stays unwrapped', () => {
    expect(wrapInIIFE('window.location.href')).toBe('window.location.href');
  });

  test('leading/trailing whitespace is trimmed for simple expressions', () => {
    expect(wrapInIIFE('  document.title  ')).toBe('document.title');
  });

  // --- code with explicit return — must be wrapped ---

  test('bare return statement gets wrapped', () => {
    const code = "return 'hello'";
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
    expect(wrapped).toContain("return 'hello'");
  });

  test('multi-line code with explicit return gets wrapped', () => {
    const code = 'const x = 5;\nreturn x;';
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
    expect(wrapped).toContain('return x');
  });

  test('code with explicit return is not double-returned', () => {
    const code = 'const x = 5;\nreturn x;';
    const wrapped = wrapInIIFE(code);
    // Only the one return written by the LLM should be present
    expect((wrapped.match(/\breturn\b/g) ?? []).length).toBe(1);
  });

  // --- multi-statement without explicit return — wrapped with auto-return ---

  test('multi-line expression auto-returns last line', () => {
    const code = 'const x = 5;\nx';
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
    expect(wrapped).toContain('return x');
  });

  test('let declaration followed by identifier auto-returns identifier', () => {
    const code = "let result = 'test';\nresult";
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
    expect(wrapped).toContain('return result');
  });

  test('semicolon-separated single-line code gets wrapped', () => {
    const code = "const a = 1; a + 2";
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
  });

  // --- last line is a declaration — wrapped but no spurious auto-return ---

  test('code ending with a declaration is wrapped without auto-return', () => {
    const code = 'let x = 5;\nconst y = x + 1';
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
    // No auto-return injected before a const line
    expect(wrapped).not.toMatch(/return const/);
  });

  test('code ending with a closing brace is wrapped without auto-return', () => {
    const code = 'function f() { return 1; }\nf()';
    // last non-empty line is "f()" which IS auto-returnable
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain('(async () =>');
  });

  // --- IIFE structure correctness ---

  test('IIFE uses async arrow function', () => {
    const wrapped = wrapInIIFE("return 42");
    expect(wrapped).toMatch(/^\(async \(\) => \{/);
  });

  test('wrapped code ends with })()', () => {
    const wrapped = wrapInIIFE("return 42");
    expect(wrapped.trimEnd()).toMatch(/\}\)\(\)$/);
  });

  test('original code is preserved inside IIFE', () => {
    const code = "const x = 'world';\nreturn 'hello ' + x;";
    const wrapped = wrapInIIFE(code);
    expect(wrapped).toContain(code);
  });
});
