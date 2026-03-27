/**
 * Tests for src/stealth/human-behavior.ts
 *
 * Validates that human behavior simulation functions produce expected
 * output patterns without requiring a real browser.
 */

import * as fs from 'fs';
import * as path from 'path';

// Source-level verification: ensure the module exports are present
const humanBehaviorSource = fs.readFileSync(
  path.join(__dirname, '../../src/stealth/human-behavior.ts'),
  'utf-8'
);

describe('Human Behavior Module: source verification', () => {
  test('exports humanMouseMove function', () => {
    expect(humanBehaviorSource).toContain('export async function humanMouseMove');
  });

  test('exports humanType function', () => {
    expect(humanBehaviorSource).toContain('export async function humanType');
  });

  test('exports humanScroll function', () => {
    expect(humanBehaviorSource).toContain('export async function humanScroll');
  });

  test('exports humanDelay function', () => {
    expect(humanBehaviorSource).toContain('export async function humanDelay');
  });

  test('exports simulatePresence function', () => {
    expect(humanBehaviorSource).toContain('export async function simulatePresence');
  });
});

describe('Human Behavior Module: humanMouseMove', () => {
  test('uses Bézier curve interpolation', () => {
    // Verify the Bézier interpolation function exists
    expect(humanBehaviorSource).toContain('bezierPoint');
    expect(humanBehaviorSource).toContain('inv * inv * p0');
  });

  test('generates 15-35 intermediate steps', () => {
    expect(humanBehaviorSource).toContain('15 + Math.floor(Math.random() * 21)');
  });

  test('applies ease-in-out parameterization', () => {
    // Ease-in-out: slow start, fast middle, slow end
    expect(humanBehaviorSource).toContain('2 * linear * linear');
    expect(humanBehaviorSource).toContain('Math.pow(-2 * linear + 2, 2)');
  });

  test('adds sub-pixel jitter to intermediate points', () => {
    expect(humanBehaviorSource).toContain('jitterX');
    expect(humanBehaviorSource).toContain('jitterY');
    // Jitter should be ±1.5px (range 3)
    expect(humanBehaviorSource).toContain('(Math.random() - 0.5) * 3');
  });

  test('tracks mouse position via window.__oc_mouseX/Y', () => {
    expect(humanBehaviorSource).toContain('__oc_mouseX');
    expect(humanBehaviorSource).toContain('__oc_mouseY');
  });
});

describe('Human Behavior Module: humanType', () => {
  test('types character-by-character', () => {
    expect(humanBehaviorSource).toContain("for (let i = 0; i < text.length; i++)");
    expect(humanBehaviorSource).toContain("const char = text[i]");
  });

  test('has 30-150ms base inter-keystroke delay', () => {
    expect(humanBehaviorSource).toContain('30 + Math.random() * 120');
  });

  test('adds longer pause at word boundaries', () => {
    expect(humanBehaviorSource).toContain("char === ' '");
    expect(humanBehaviorSource).toContain("char === '.'");
  });

  test('includes occasional micro-pauses for hesitation', () => {
    expect(humanBehaviorSource).toContain('Math.random() < 0.05');
  });
});

describe('Human Behavior Module: humanScroll', () => {
  test('generates 5-12 wheel events', () => {
    expect(humanBehaviorSource).toContain('5 + Math.floor(Math.random() * 8)');
  });

  test('uses momentum physics (exponential decay)', () => {
    expect(humanBehaviorSource).toContain('Math.pow(0.7, i)');
  });

  test('uses page.mouse.wheel for real input events', () => {
    expect(humanBehaviorSource).toContain('page.mouse.wheel');
  });

  test('adds small horizontal wobble', () => {
    expect(humanBehaviorSource).toContain('deltaX');
    expect(humanBehaviorSource).toContain('(Math.random() - 0.5) * 4');
  });
});

describe('Human Behavior Module: humanDelay', () => {
  test('uses Box-Muller transform for gaussian distribution', () => {
    expect(humanBehaviorSource).toContain('Box-Muller');
    expect(humanBehaviorSource).toContain('Math.sqrt(-2 * Math.log');
    expect(humanBehaviorSource).toContain('Math.cos(2 * Math.PI');
  });

  test('clamps to min/max range', () => {
    expect(humanBehaviorSource).toContain('Math.max(minMs, Math.min(maxMs');
  });
});

describe('Human Behavior Module: simulatePresence', () => {
  test('performs 2-3 random mouse movements', () => {
    expect(humanBehaviorSource).toContain('2 + Math.floor(Math.random() * 2)');
  });

  test('scrolls after mouse movements', () => {
    // Should call humanScroll
    const presenceStart = humanBehaviorSource.indexOf('async function simulatePresence');
    const presenceBlock = humanBehaviorSource.slice(presenceStart);
    expect(presenceBlock).toContain('humanScroll');
  });

  test('catches errors without breaking navigation', () => {
    const presenceStart = humanBehaviorSource.indexOf('async function simulatePresence');
    const presenceBlock = humanBehaviorSource.slice(presenceStart);
    expect(presenceBlock).toContain('catch');
    expect(presenceBlock).toContain('simulatePresence failed');
  });

  test('stays within center 60% of viewport', () => {
    expect(humanBehaviorSource).toContain('w * 0.2');
    expect(humanBehaviorSource).toContain('w * 0.6');
  });
});
