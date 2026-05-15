/// <reference types="jest" />

import { countLoc } from './loc-counter';

describe('countLoc', () => {
  test('counts each statement as one LOC', () => {
    const src = `const a = 1;\nconst b = 2;\nconst c = 3;\n`;
    expect(countLoc(src).loc).toBe(3);
  });

  test('blank lines do not count', () => {
    const r = countLoc(`const a = 1;\n\n\nconst b = 2;\n`);
    expect(r.loc).toBe(2);
    expect(r.blankLines).toBe(3);
  });

  test('single-line comments do not count', () => {
    const r = countLoc(`// header\nconst a = 1;\n// trailer\n`);
    expect(r.loc).toBe(1);
    expect(r.commentLines).toBe(2);
  });

  test('block comments are stripped entirely', () => {
    const r = countLoc(`/*\n  doc block\n  spans lines\n*/\nconst a = 1;\n`);
    expect(r.loc).toBe(1);
  });

  test('imports count toward LOC per the issue rule', () => {
    const r = countLoc(`import * as fs from 'fs';\nconst x = fs.readFileSync('a');\n`);
    expect(r.loc).toBe(2);
  });

  test('jsdoc-style block comment is excluded', () => {
    const r = countLoc(`/**\n * Sample doc\n * line two\n */\nconst a = 1;\n`);
    expect(r.loc).toBe(1);
  });
});
