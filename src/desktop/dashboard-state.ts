/**
 * Dashboard State - Tracks tool calls and session info for the desktop dashboard.
 *
 * Provides a lightweight ring buffer of recent tool calls per session,
 * consumed by the REST API endpoints in the HTTP transport.
 */

import { ToolCallEvent, ToolCallResult } from '../dashboard/types';

/** Maximum tool calls retained per session */
const MAX_CALLS_PER_SESSION = 50;

export interface DashboardToolCall {
  id: string;
  toolName: string;
  sessionId: string;
  args: string;
  status: 'running' | 'success' | 'error';
  startTime: number;
  endTime?: number;
  duration?: number;
  error?: string;
}

export interface SessionSummary {
  sessionId: string;
  totalCalls: number;
  activeCalls: number;
  lastActivity: number;
}

/**
 * Ring buffer that retains at most `capacity` items per session.
 */
class PerSessionRingBuffer {
  private buffers = new Map<string, DashboardToolCall[]>();
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(sessionId: string, call: DashboardToolCall): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    buf.unshift(call);
    if (buf.length > this.capacity) {
      buf.length = this.capacity;
    }
  }

  get(sessionId: string, limit?: number): DashboardToolCall[] {
    const buf = this.buffers.get(sessionId);
    if (!buf) return [];
    return limit ? buf.slice(0, limit) : buf.slice();
  }

  getAll(limit?: number): DashboardToolCall[] {
    const all: DashboardToolCall[] = [];
    for (const buf of this.buffers.values()) {
      all.push(...buf);
    }
    // Sort by startTime descending (most recent first)
    all.sort((a, b) => b.startTime - a.startTime);
    return limit ? all.slice(0, limit) : all;
  }

  sessionIds(): string[] {
    return Array.from(this.buffers.keys());
  }

  sessionStats(sessionId: string): { total: number; active: number; lastActivity: number } {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) {
      return { total: 0, active: 0, lastActivity: 0 };
    }
    let active = 0;
    let lastActivity = 0;
    for (const call of buf) {
      if (call.status === 'running') active++;
      const t = call.endTime || call.startTime;
      if (t > lastActivity) lastActivity = t;
    }
    return { total: buf.length, active, lastActivity };
  }
}

export class DashboardState {
  private calls = new PerSessionRingBuffer(MAX_CALLS_PER_SESSION);
  private activeCalls = new Map<string, DashboardToolCall>();
  private startTime = Date.now();

  /**
   * Record the start of a tool call. Returns the call ID for later completion.
   */
  recordToolStart(sessionId: string, toolName: string, args: Record<string, unknown> | undefined, callId: string): void {
    const argSummary = args ? summarizeArgs(args) : '';
    const call: DashboardToolCall = {
      id: callId,
      toolName,
      sessionId,
      args: argSummary,
      status: 'running',
      startTime: Date.now(),
    };
    this.activeCalls.set(callId, call);
    this.calls.push(sessionId, call);
  }

  /**
   * Record the end of a tool call.
   */
  recordToolEnd(callId: string, status: 'success' | 'error', error?: string): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    call.status = status;
    call.endTime = Date.now();
    call.duration = call.endTime - call.startTime;
    if (error) {
      call.error = error;
    }
    this.activeCalls.delete(callId);
  }

  /**
   * Get tool calls, optionally filtered by session and limited.
   */
  getToolCalls(sessionId?: string, limit?: number): DashboardToolCall[] {
    if (sessionId) {
      return this.calls.get(sessionId, limit);
    }
    return this.calls.getAll(limit);
  }

  /**
   * Get summaries for all sessions that have had tool calls.
   */
  getSessionSummaries(): SessionSummary[] {
    return this.calls.sessionIds().map((sid) => {
      const stats = this.calls.sessionStats(sid);
      return {
        sessionId: sid,
        totalCalls: stats.total,
        activeCalls: stats.active,
        lastActivity: stats.lastActivity,
      };
    });
  }

  /**
   * Get server uptime in seconds.
   */
  getUptimeSecs(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}

/**
 * Summarize tool args into a short string for dashboard display.
 * Truncates to 200 chars to avoid bloating the ring buffer.
 */
function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(args);
    return str.length > 200 ? str.slice(0, 197) + '...' : str;
  } catch {
    return '[unserializable]';
  }
}

// Singleton
let instance: DashboardState | null = null;

export function getDashboardState(): DashboardState {
  if (!instance) {
    instance = new DashboardState();
  }
  return instance;
}
