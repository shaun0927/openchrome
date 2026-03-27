/**
 * Fingerprint Defense Scripts for Stealth Mode
 *
 * Returns JavaScript source strings to be injected via evaluateOnNewDocument
 * and page.evaluate for stealth pages. These scripts spoof browser fingerprints
 * that enterprise anti-bot systems (Radware, PerimeterX, Akamai) check.
 *
 * All scripts are self-contained closures — no external dependencies.
 */

/**
 * Returns a JS source string that spoofs WebGL, Canvas, Audio, and hardware
 * fingerprints. Designed for evaluateOnNewDocument injection.
 */
export function getStealthFingerprintDefenseScript(): string {
  return `(function() {
    'use strict';

    // -----------------------------------------------------------------------
    // 1. WebGL Renderer Spoofing
    // Headless Chrome uses "Google SwiftShader" which is trivially detectable.
    // Override getParameter for UNMASKED_VENDOR_WEBGL (37445) and
    // UNMASKED_RENDERER_WEBGL (37446) to return realistic GPU strings.
    // -----------------------------------------------------------------------
    const UNMASKED_VENDOR = 0x9245;  // 37445
    const UNMASKED_RENDERER = 0x9246; // 37446

    // Realistic GPU strings by platform
    var gpuVendor = 'Intel Inc.';
    var gpuRenderer = 'Intel Iris OpenGL Engine';
    try {
      if (navigator.platform && navigator.platform.indexOf('Win') !== -1) {
        gpuVendor = 'Google Inc. (NVIDIA)';
        gpuRenderer = 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      } else if (navigator.platform && navigator.platform.indexOf('Linux') !== -1) {
        gpuVendor = 'Google Inc. (Intel)';
        gpuRenderer = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)';
      }
    } catch(e) {}

    function patchWebGL(proto) {
      if (!proto || !proto.getParameter) return;
      var original = proto.getParameter;
      proto.getParameter = function(param) {
        if (param === UNMASKED_VENDOR) return gpuVendor;
        if (param === UNMASKED_RENDERER) return gpuRenderer;
        return original.call(this, param);
      };
    }

    if (typeof WebGLRenderingContext !== 'undefined') {
      patchWebGL(WebGLRenderingContext.prototype);
    }
    if (typeof WebGL2RenderingContext !== 'undefined') {
      patchWebGL(WebGL2RenderingContext.prototype);
    }

    // -----------------------------------------------------------------------
    // 2. Canvas Fingerprint Noise
    // Override toDataURL and toBlob to inject subtle pixel noise that prevents
    // consistent canvas fingerprint hashing across sessions.
    // -----------------------------------------------------------------------
    var canvasSeed = Math.random() * 10000;

    function injectCanvasNoise(canvas) {
      try {
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        var w = Math.min(canvas.width, 16);
        var h = Math.min(canvas.height, 16);
        if (w <= 0 || h <= 0) return;
        var imageData = ctx.getImageData(0, 0, w, h);
        var data = imageData.data;
        for (var i = 0; i < data.length; i += 4) {
          // Deterministic per-session noise: ±1 on RGB channels
          var noise = ((canvasSeed * (i + 1) * 9301 + 49297) % 233280) / 233280;
          data[i] = Math.max(0, Math.min(255, data[i] + Math.round((noise - 0.5) * 2)));
        }
        ctx.putImageData(imageData, 0, 0);
      } catch(e) {}
    }

    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      injectCanvasNoise(this);
      return origToDataURL.apply(this, arguments);
    };

    if (HTMLCanvasElement.prototype.toBlob) {
      var origToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function() {
        injectCanvasNoise(this);
        return origToBlob.apply(this, arguments);
      };
    }

    // -----------------------------------------------------------------------
    // 3. AudioContext Fingerprint Noise
    // Override AnalyserNode frequency data methods to add micro-noise.
    // -----------------------------------------------------------------------
    if (typeof AnalyserNode !== 'undefined') {
      var origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      if (origGetFloat) {
        AnalyserNode.prototype.getFloatFrequencyData = function(array) {
          origGetFloat.call(this, array);
          for (var i = 0; i < array.length; i++) {
            array[i] += (Math.random() - 0.5) * 0.1;
          }
        };
      }

      var origGetByte = AnalyserNode.prototype.getByteFrequencyData;
      if (origGetByte) {
        AnalyserNode.prototype.getByteFrequencyData = function(array) {
          origGetByte.call(this, array);
          for (var i = 0; i < array.length; i++) {
            array[i] = Math.max(0, Math.min(255, array[i] + Math.round((Math.random() - 0.5) * 2)));
          }
        };
      }
    }

    // -----------------------------------------------------------------------
    // 4. Hardware Property Spoofing
    // Set realistic values for navigator properties that headless/automated
    // environments may report differently.
    // -----------------------------------------------------------------------
    try {
      if (navigator.hardwareConcurrency === undefined || navigator.hardwareConcurrency < 2) {
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
          get: function() { return 8; },
          configurable: true,
        });
      }
    } catch(e) {}

    try {
      if (!navigator.deviceMemory || navigator.deviceMemory < 2) {
        Object.defineProperty(Navigator.prototype, 'deviceMemory', {
          get: function() { return 8; },
          configurable: true,
        });
      }
    } catch(e) {}

    // NetworkInformation API
    try {
      if (navigator.connection) {
        var conn = navigator.connection;
        try {
          Object.defineProperty(conn, 'effectiveType', {
            get: function() { return '4g'; }, configurable: true,
          });
        } catch(e) {}
        try {
          Object.defineProperty(conn, 'downlink', {
            get: function() { return 10; }, configurable: true,
          });
        } catch(e) {}
        try {
          Object.defineProperty(conn, 'rtt', {
            get: function() { return 50; }, configurable: true,
          });
        } catch(e) {}
        try {
          Object.defineProperty(conn, 'saveData', {
            get: function() { return false; }, configurable: true,
          });
        } catch(e) {}
      }
    } catch(e) {}

    // -----------------------------------------------------------------------
    // 5. Screen Dimension Consistency
    // Ensure screen.* properties are consistent with window dimensions.
    // Headless Chrome may report 0 or mismatched values.
    // -----------------------------------------------------------------------
    try {
      if (screen.width === 0 || screen.height === 0) {
        Object.defineProperty(Screen.prototype, 'width', {
          get: function() { return window.innerWidth || 1920; }, configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'height', {
          get: function() { return window.innerHeight + 85 || 1080; }, configurable: true,
        });
      }
      if (screen.availWidth === 0 || screen.availHeight === 0) {
        Object.defineProperty(Screen.prototype, 'availWidth', {
          get: function() { return screen.width; }, configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'availHeight', {
          get: function() { return screen.height - 40; }, configurable: true,
        });
      }
      if (!screen.colorDepth || screen.colorDepth < 24) {
        Object.defineProperty(Screen.prototype, 'colorDepth', {
          get: function() { return 24; }, configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'pixelDepth', {
          get: function() { return 24; }, configurable: true,
        });
      }
    } catch(e) {}

    // -----------------------------------------------------------------------
    // 6. navigator.webdriver — Prototype-level removal
    // Instead of defineProperty on the instance (detectable via
    // getOwnPropertyDescriptor), delete from the prototype so the property
    // simply doesn't exist. The --disable-blink-features=AutomationControlled
    // flag already prevents it from being set; this is defense-in-depth for
    // headless mode where the flag may not take effect.
    // -----------------------------------------------------------------------
    try {
      delete Object.getPrototypeOf(navigator).webdriver;
    } catch(e) {}

  })();`;
}

/**
 * Returns a JS source string that sanitizes Error.stack to remove
 * CDP-related frames that could reveal automation.
 */
export function getStealthStackSanitizationScript(): string {
  return `(function() {
    'use strict';

    // Filter CDP/Puppeteer artifacts from Error stack traces.
    // Anti-bot systems inspect Error().stack for automation signatures.
    var cdpPatterns = [
      'pptr:',
      '__puppeteer',
      'evaluateOnNewDocument',
      'app.js:',
      'util:',
      'DevTools',
      'debugger eval',
    ];

    if (typeof Error !== 'undefined' && Error.prepareStackTrace) {
      var origPrepare = Error.prepareStackTrace;
      Error.prepareStackTrace = function(error, structuredStack) {
        var filtered = structuredStack.filter(function(frame) {
          var fileName = '';
          try { fileName = frame.getFileName() || ''; } catch(e) {}
          var fnName = '';
          try { fnName = frame.getFunctionName() || ''; } catch(e) {}
          var combined = fileName + ' ' + fnName;
          for (var i = 0; i < cdpPatterns.length; i++) {
            if (combined.indexOf(cdpPatterns[i]) !== -1) return false;
          }
          return true;
        });
        return origPrepare ? origPrepare(error, filtered) : error + '\\n' + filtered.join('\\n');
      };
    }
  })();`;
}
