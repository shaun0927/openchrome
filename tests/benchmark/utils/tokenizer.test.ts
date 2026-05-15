/// <reference types="jest" />

import { countTokens, countTokensOfValue, TOKENIZER_ENCODING } from './tokenizer';

describe('benchmark tokenizer', () => {
  test('exposes the cl100k_base encoding name', () => {
    expect(TOKENIZER_ENCODING).toBe('cl100k_base');
  });

  test('counts tokens of a known string deterministically', () => {
    const a = countTokens('hello world');
    const b = countTokens('hello world');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  test('is a real tokenizer, not a chars/4 estimate', () => {
    // ' a' repeated 8 times — 8 short repeated tokens. chars/4 would guess ~4;
    // a real BPE tokenizer produces a different, exact count.
    const text = ' a'.repeat(8);
    const tokens = countTokens(text);
    expect(tokens).toBe(8);
    expect(tokens).not.toBe(Math.ceil(text.length / 4));
  });

  test('treats empty / nullish input as zero tokens', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens(undefined)).toBe(0);
  });

  test('longer text yields more tokens', () => {
    expect(countTokens('word '.repeat(100))).toBeGreaterThan(countTokens('word '.repeat(10)));
  });

  test('countTokensOfValue stringifies non-string values', () => {
    expect(countTokensOfValue(null)).toBe(0);
    expect(countTokensOfValue(undefined)).toBe(0);
    expect(countTokensOfValue('plain string')).toBe(countTokens('plain string'));

    const obj = { tool: 'read_page', args: { mode: 'dom' } };
    expect(countTokensOfValue(obj)).toBe(countTokens(JSON.stringify(obj)));
    expect(countTokensOfValue(obj)).toBeGreaterThan(0);
  });
});
