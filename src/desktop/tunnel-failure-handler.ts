/**
 * TunnelFailureHandler — classifies cloudflared failures, manages retries,
 * and falls back to local-only mode after max retries are exceeded.
 * Part of #524 Error handling + local fallback + CLI coexistence.
 */

import { EventEmitter } from 'events';

export type TunnelFailureReason =
  | 'process_crash'      // cloudflared process exited unexpectedly
  | 'network_disconnect'  // network connectivity lost
  | 'firewall_block'     // cloudflared binary blocked by firewall/antivirus
  | 'timeout'            // tunnel establishment timeout
  | 'dns_failure'        // DNS resolution failed
  | 'unknown';

export type TunnelMode = 'tunnel' | 'local-only' | 'reconnecting';

export interface TunnelFailureEvent {
  reason: TunnelFailureReason;
  message: string;      // Plain-language message for UI (no jargon)
  suggestion: string;   // Actionable suggestion for user
  canRetry: boolean;
  timestamp: number;
}

export class TunnelFailureHandler extends EventEmitter {
  private mode: TunnelMode = 'tunnel';
  private consecutiveFailures = 0;
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 10000;
  private retryTimer: NodeJS.Timeout | null = null;

  /**
   * Detect failure reason from cloudflared stderr output and process exit code.
   */
  classifyFailure(exitCode: number | null, stderr: string): TunnelFailureReason {
    const lower = stderr.toLowerCase();

    if (lower.includes('connection refused') || lower.includes('econnrefused')) {
      return 'network_disconnect';
    }

    if (lower.includes('permission denied') || lower.includes('eacces')) {
      return 'firewall_block';
    }

    if (lower.includes('dns') || lower.includes('resolve')) {
      return 'dns_failure';
    }

    if (exitCode === null) {
      return 'timeout';
    }

    if (exitCode === 1) {
      return 'process_crash';
    }

    return 'unknown';
  }

  /**
   * Handle a tunnel failure: increment counter, emit events, manage retries.
   * Switches to local-only mode after maxRetries consecutive failures.
   */
  handleFailure(exitCode: number | null, stderr: string): TunnelFailureEvent {
    const reason = this.classifyFailure(exitCode, stderr);
    this.consecutiveFailures++;

    const event: TunnelFailureEvent = {
      reason,
      message: this.getPlainMessage(reason),
      suggestion: this.getSuggestion(reason),
      canRetry: this.consecutiveFailures < this.maxRetries,
      timestamp: Date.now(),
    };

    this.emit('tunnel-failure', event);

    if (this.consecutiveFailures < this.maxRetries) {
      this.mode = 'reconnecting';
      this.emit('tunnel-reconnecting', { attempt: this.consecutiveFailures, delayMs: this.retryDelayMs });

      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
      }
      // Backoff delay — callers should listen to 'tunnel-reconnecting' and re-attempt
      // connection after the delay expires. The timer itself only resets state.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.emit('tunnel-retry-ready', { attempt: this.consecutiveFailures });
      }, this.retryDelayMs);
      this.retryTimer.unref();
    } else {
      this.fallbackToLocalOnly();
    }

    return event;
  }

  /**
   * Get plain-language message for a failure reason (no technical jargon).
   */
  private getPlainMessage(reason: TunnelFailureReason): string {
    switch (reason) {
      case 'process_crash':
        return 'The secure connection stopped unexpectedly';
      case 'network_disconnect':
        return 'Your internet connection appears to be down';
      case 'firewall_block':
        return 'Your firewall or antivirus may be blocking the connection';
      case 'timeout':
        return 'The connection is taking too long to establish';
      case 'dns_failure':
        return 'Unable to reach the connection service';
      case 'unknown':
        return 'An unexpected connection error occurred';
    }
  }

  /**
   * Get actionable suggestion for a failure reason.
   */
  private getSuggestion(reason: TunnelFailureReason): string {
    switch (reason) {
      case 'process_crash':
        return 'The app will try to reconnect automatically. If this keeps happening, try restarting the app.';
      case 'network_disconnect':
        return 'Check your internet connection and try again.';
      case 'firewall_block':
        return 'Check your firewall or antivirus settings and allow this app, then restart.';
      case 'timeout':
        return 'Check your internet connection. If the problem persists, try restarting the app.';
      case 'dns_failure':
        return 'Check your internet connection or try switching to a different network.';
      case 'unknown':
        return 'Try restarting the app. If the problem continues, check your network settings.';
    }
  }

  /**
   * Switch to local-only mode after max retries exceeded.
   */
  private fallbackToLocalOnly(): void {
    this.mode = 'local-only';

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.emit('tunnel-local-only', {
      consecutiveFailures: this.consecutiveFailures,
    });
  }

  /**
   * Reset failure counter and mode when tunnel is successfully restored.
   */
  resetOnSuccess(): void {
    const wasReconnecting = this.mode === 'reconnecting';
    const wasLocalOnly = this.mode === 'local-only';

    this.consecutiveFailures = 0;
    this.mode = 'tunnel';

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (wasReconnecting || wasLocalOnly) {
      this.emit('tunnel-restored');
    }
  }

  /**
   * Get the current tunnel mode.
   */
  getMode(): TunnelMode {
    return this.mode;
  }

  /**
   * Clean up timers and remove all listeners.
   */
  destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.removeAllListeners();
  }
}
