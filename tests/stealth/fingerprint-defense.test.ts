/**
 * Tests for src/stealth/fingerprint-defense.ts
 *
 * Validates that fingerprint defense scripts contain the expected
 * spoofing techniques and are syntactically valid JavaScript.
 */

import {
  getStealthFingerprintDefenseScript,
  getStealthStackSanitizationScript,
} from '../../src/stealth/fingerprint-defense';

describe('Fingerprint Defense: getStealthFingerprintDefenseScript', () => {
  const script = getStealthFingerprintDefenseScript();

  test('returns a non-empty string', () => {
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);
  });

  test('is a valid JavaScript IIFE', () => {
    expect(script.trim()).toMatch(/^\(function\(\)/);
    expect(script.trim()).toMatch(/\}\)\(\);$/);
  });

  test('is syntactically valid JavaScript', () => {
    // Should not throw when parsed
    expect(() => new Function(script)).not.toThrow();
  });

  // --- WebGL Renderer Spoofing ---
  describe('WebGL renderer spoofing', () => {
    test('overrides UNMASKED_VENDOR_WEBGL (37445 / 0x9245)', () => {
      expect(script).toContain('0x9245');
      expect(script).toContain('UNMASKED_VENDOR');
    });

    test('overrides UNMASKED_RENDERER_WEBGL (37446 / 0x9246)', () => {
      expect(script).toContain('0x9246');
      expect(script).toContain('UNMASKED_RENDERER');
    });

    test('patches both WebGLRenderingContext and WebGL2RenderingContext', () => {
      expect(script).toContain('WebGLRenderingContext.prototype');
      expect(script).toContain('WebGL2RenderingContext.prototype');
    });

    test('returns realistic GPU vendor string', () => {
      expect(script).toContain('Intel Inc.');
    });

    test('returns realistic GPU renderer string', () => {
      expect(script).toContain('Intel Iris OpenGL Engine');
    });

    test('provides platform-specific GPU strings', () => {
      // Windows
      expect(script).toContain('NVIDIA');
      expect(script).toContain('Direct3D11');
      // Linux
      expect(script).toContain('Mesa Intel');
    });
  });

  // --- Canvas Fingerprint Noise ---
  describe('Canvas fingerprint noise', () => {
    test('overrides HTMLCanvasElement.prototype.toDataURL', () => {
      expect(script).toContain('HTMLCanvasElement.prototype.toDataURL');
    });

    test('overrides toBlob if available', () => {
      expect(script).toContain('HTMLCanvasElement.prototype.toBlob');
    });

    test('uses per-session seed for deterministic noise', () => {
      expect(script).toContain('canvasSeed');
    });

    test('injects noise into pixel data', () => {
      expect(script).toContain('getImageData');
      expect(script).toContain('putImageData');
    });
  });

  // --- AudioContext Fingerprint Noise ---
  describe('AudioContext fingerprint noise', () => {
    test('overrides AnalyserNode.prototype.getFloatFrequencyData', () => {
      expect(script).toContain('AnalyserNode.prototype');
      expect(script).toContain('getFloatFrequencyData');
    });

    test('overrides getByteFrequencyData', () => {
      expect(script).toContain('getByteFrequencyData');
    });

    test('adds micro-noise to frequency data', () => {
      expect(script).toContain('(Math.random() - 0.5)');
    });
  });

  // --- Hardware Property Spoofing ---
  describe('Hardware property spoofing', () => {
    test('spoofs navigator.hardwareConcurrency', () => {
      expect(script).toContain('hardwareConcurrency');
      expect(script).toContain('return 8');
    });

    test('spoofs navigator.deviceMemory', () => {
      expect(script).toContain('deviceMemory');
    });

    test('spoofs navigator.connection properties', () => {
      expect(script).toContain('effectiveType');
      expect(script).toContain("'4g'");
      expect(script).toContain('downlink');
      expect(script).toContain('rtt');
      expect(script).toContain('saveData');
    });
  });

  // --- Screen Dimension Consistency ---
  describe('Screen dimension consistency', () => {
    test('fixes screen.width and screen.height', () => {
      expect(script).toContain('Screen.prototype');
      expect(script).toContain("'width'");
      expect(script).toContain("'height'");
    });

    test('fixes screen.availWidth and screen.availHeight', () => {
      expect(script).toContain("'availWidth'");
      expect(script).toContain("'availHeight'");
    });

    test('fixes screen.colorDepth and screen.pixelDepth', () => {
      expect(script).toContain("'colorDepth'");
      expect(script).toContain("'pixelDepth'");
      expect(script).toContain('return 24');
    });
  });

  // --- navigator.webdriver prototype deletion ---
  describe('navigator.webdriver handling', () => {
    test('uses prototype-level deletion instead of defineProperty', () => {
      expect(script).toContain('delete Object.getPrototypeOf(navigator).webdriver');
    });
  });

  // --- Uses prototype-level patching ---
  describe('uses prototype-level patching where possible', () => {
    test('patches Navigator.prototype for hardware props', () => {
      expect(script).toContain('Navigator.prototype');
    });

    test('patches Screen.prototype for screen dimensions', () => {
      expect(script).toContain('Screen.prototype');
    });
  });
});

describe('Fingerprint Defense: getStealthStackSanitizationScript', () => {
  const script = getStealthStackSanitizationScript();

  test('returns a non-empty string', () => {
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(50);
  });

  test('is a valid JavaScript IIFE', () => {
    expect(script.trim()).toMatch(/^\(function\(\)/);
    expect(script.trim()).toMatch(/\}\)\(\);$/);
  });

  test('is syntactically valid JavaScript', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  test('filters CDP-related patterns from Error.stack', () => {
    expect(script).toContain('cdpPatterns');
    expect(script).toContain("'pptr:'");
    expect(script).toContain("'__puppeteer'");
    expect(script).toContain("'evaluateOnNewDocument'");
  });

  test('overrides Error.prepareStackTrace', () => {
    expect(script).toContain('Error.prepareStackTrace');
  });

  test('uses getFileName and getFunctionName for frame filtering', () => {
    expect(script).toContain('getFileName');
    expect(script).toContain('getFunctionName');
  });
});
