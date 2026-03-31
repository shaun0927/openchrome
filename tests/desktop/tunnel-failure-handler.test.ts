/// <reference types="jest" />

import { TunnelFailureHandler, TunnelFailureReason } from '../../src/desktop/tunnel-failure-handler';

describe('TunnelFailureHandler', () => {
  let handler: TunnelFailureHandler;

  beforeEach(() => {
    handler = new TunnelFailureHandler();
    jest.useFakeTimers();
  });

  afterEach(() => {
    handler.destroy();
    jest.useRealTimers();
  });

  // --- classifyFailure ---

  describe('classifyFailure', () => {
    test('returns network_disconnect for "connection refused"', () => {
      expect(handler.classifyFailure(1, 'connection refused')).toBe('network_disconnect');
    });

    test('returns network_disconnect for ECONNREFUSED', () => {
      expect(handler.classifyFailure(1, 'Error: ECONNREFUSED 127.0.0.1:7844')).toBe('network_disconnect');
    });

    test('returns firewall_block for "permission denied"', () => {
      expect(handler.classifyFailure(1, 'permission denied: /usr/local/bin/cloudflared')).toBe('firewall_block');
    });

    test('returns firewall_block for EACCES', () => {
      expect(handler.classifyFailure(1, 'EACCES: permission denied')).toBe('firewall_block');
    });

    test('returns dns_failure for DNS error', () => {
      expect(handler.classifyFailure(1, 'DNS resolution failed for argotunnel.com')).toBe('dns_failure');
    });

    test('returns dns_failure for resolve error', () => {
      expect(handler.classifyFailure(1, 'failed to resolve host')).toBe('dns_failure');
    });

    test('returns timeout for null exit code', () => {
      expect(handler.classifyFailure(null, '')).toBe('timeout');
    });

    test('returns process_crash for exit code 1 with no known pattern', () => {
      expect(handler.classifyFailure(1, 'unexpected error occurred')).toBe('process_crash');
    });

    test('returns unknown for unrecognized exit code and stderr', () => {
      expect(handler.classifyFailure(99, 'some unknown output')).toBe('unknown');
    });
  });

  // --- handleFailure ---

  describe('handleFailure', () => {
    test('emits tunnel-failure event on first failure', () => {
      const failureHandler = jest.fn();
      handler.on('tunnel-failure', failureHandler);

      handler.handleFailure(1, 'unexpected error occurred');

      expect(failureHandler).toHaveBeenCalledTimes(1);
      expect(failureHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'process_crash',
          canRetry: true,
        })
      );
    });

    test('emits tunnel-reconnecting after first failure', () => {
      const reconnectHandler = jest.fn();
      handler.on('tunnel-reconnecting', reconnectHandler);

      handler.handleFailure(1, 'unexpected error occurred');

      expect(reconnectHandler).toHaveBeenCalledTimes(1);
      expect(reconnectHandler).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1 })
      );
    });

    test('sets mode to reconnecting after first failure', () => {
      handler.handleFailure(1, 'unexpected error occurred');
      expect(handler.getMode()).toBe('reconnecting');
    });

    test('increments consecutiveFailures on each handleFailure call', () => {
      handler.handleFailure(1, 'unexpected error occurred');
      handler.handleFailure(1, 'unexpected error occurred');

      const failureHandler = jest.fn();
      handler.on('tunnel-failure', failureHandler);
      const event = handler.handleFailure(1, 'unexpected error occurred');
      expect(event.canRetry).toBe(false);
    });

    test('falls back to local-only after maxRetries (3) failures', () => {
      const localOnlyHandler = jest.fn();
      handler.on('tunnel-local-only', localOnlyHandler);

      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');

      expect(localOnlyHandler).toHaveBeenCalledTimes(1);
      expect(handler.getMode()).toBe('local-only');
    });

    test('does not emit tunnel-local-only before maxRetries exceeded', () => {
      const localOnlyHandler = jest.fn();
      handler.on('tunnel-local-only', localOnlyHandler);

      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');

      expect(localOnlyHandler).not.toHaveBeenCalled();
      expect(handler.getMode()).toBe('reconnecting');
    });

    test('returns event with timestamp', () => {
      const before = Date.now();
      const event = handler.handleFailure(1, 'err');
      const after = Date.now();

      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // --- resetOnSuccess ---

  describe('resetOnSuccess', () => {
    test('resets mode to tunnel after reconnecting', () => {
      handler.handleFailure(1, 'err');
      expect(handler.getMode()).toBe('reconnecting');

      handler.resetOnSuccess();
      expect(handler.getMode()).toBe('tunnel');
    });

    test('resets mode to tunnel after local-only', () => {
      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      expect(handler.getMode()).toBe('local-only');

      handler.resetOnSuccess();
      expect(handler.getMode()).toBe('tunnel');
    });

    test('emits tunnel-restored event after recovery from reconnecting', () => {
      const restoredHandler = jest.fn();
      handler.on('tunnel-restored', restoredHandler);

      handler.handleFailure(1, 'err');
      handler.resetOnSuccess();

      expect(restoredHandler).toHaveBeenCalledTimes(1);
    });

    test('emits tunnel-restored event after recovery from local-only', () => {
      const restoredHandler = jest.fn();
      handler.on('tunnel-restored', restoredHandler);

      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      handler.resetOnSuccess();

      expect(restoredHandler).toHaveBeenCalledTimes(1);
    });

    test('allows failures to be counted from zero again after reset', () => {
      const localOnlyHandler = jest.fn();
      handler.on('tunnel-local-only', localOnlyHandler);

      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      handler.resetOnSuccess();

      // After reset, need 3 more failures to trigger local-only
      handler.handleFailure(1, 'err');
      handler.handleFailure(1, 'err');
      expect(localOnlyHandler).not.toHaveBeenCalled();

      handler.handleFailure(1, 'err');
      expect(localOnlyHandler).toHaveBeenCalledTimes(1);
    });
  });

  // --- plain messages (no jargon) ---

  describe('plain-language messages', () => {
    const jargonPatterns = [/cloudflared/i, /stderr/i, /ECONNREFUSED/i, /EACCES/i, /exit code/i];

    function hasNoJargon(message: string): boolean {
      return jargonPatterns.every(pattern => !pattern.test(message));
    }

    const reasons: Array<[number | null, string, TunnelFailureReason]> = [
      [1, 'unexpected error', 'process_crash'],
      [1, 'connection refused', 'network_disconnect'],
      [1, 'permission denied', 'firewall_block'],
      [null, '', 'timeout'],
      [1, 'DNS resolution failed', 'dns_failure'],
    ];

    test.each(reasons)('message for %s / %s has no technical jargon', (_exitCode, _stderr, _reason) => {
      const event = handler.handleFailure(_exitCode, _stderr);
      expect(hasNoJargon(event.message)).toBe(true);
      expect(event.message.length).toBeGreaterThan(0);
    });
  });

  // --- destroy ---

  describe('destroy', () => {
    test('clears retry timer on destroy', () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      handler.handleFailure(1, 'err'); // schedules retry timer
      handler.destroy();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    test('removes all listeners on destroy', () => {
      handler.on('tunnel-failure', jest.fn());
      handler.on('tunnel-reconnecting', jest.fn());
      handler.destroy();

      expect(handler.listenerCount('tunnel-failure')).toBe(0);
      expect(handler.listenerCount('tunnel-reconnecting')).toBe(0);
    });
  });
});
