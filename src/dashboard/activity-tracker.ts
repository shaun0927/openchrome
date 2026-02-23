/**
 * Activity Tracker - Tracks tool calls and their execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ToolCallEvent, ToolCallResult } from './types.js';

export interface ActivityTrackerEvents {
  'call:start': (event: ToolCallEvent) => void;
  'call:end': (event: ToolCallEvent) => void;
}

export class ActivityTracker extends EventEmitter {
  private calls: Map<string, ToolCallEvent> = new Map();
  private completedCalls: ToolCallEvent[] = [];
  private maxHistory: number;
  private callCounter: number = 0;
  private logFilePath: string | null = null;

  // Buffered async write stream
  private timelineStream: fs.WriteStream | null = null;
  private timelineBuffer: string[] = [];
  private timelineFlushTimer: NodeJS.Timeout | null = null;
  private static readonly TIMELINE_FLUSH_INTERVAL = 200; // ms

  constructor(maxHistory: number = 100) {
    super();
    this.maxHistory = maxHistory;

    // Flush remaining buffer on process exit
    process.on('exit', () => {
      this.flushTimeline();
    });
  }

  enableFileLogging(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      this.logFilePath = path.join(dirPath, `timeline-${new Date().toISOString().slice(0, 10)}.jsonl`);
      this.timelineStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
    } catch (err) {
      console.error('[ActivityTracker] Failed to enable file logging:', err);
    }
  }

  /**
   * Start tracking a tool call
   * @returns callId for tracking
   */
  startCall(
    toolName: string,
    sessionId: string,
    args?: Record<string, unknown>,
    requestId?: number | string
  ): string {
    const callId = `call-${Date.now()}-${++this.callCounter}`;

    const event: ToolCallEvent = {
      id: callId,
      toolName,
      sessionId,
      args,
      startTime: Date.now(),
      result: 'pending',
      ...(requestId !== undefined && { requestId }),
    };

    this.calls.set(callId, event);
    this.emit('call:start', event);

    return callId;
  }

  /**
   * End a tracked tool call
   */
  endCall(
    callId: string,
    result: Exclude<ToolCallResult, 'pending'>,
    error?: string
  ): void {
    const event = this.calls.get(callId);
    if (!event) {
      return;
    }

    event.endTime = Date.now();
    event.duration = event.endTime - event.startTime;
    event.result = result;
    if (error) {
      event.error = error;
    }

    this.calls.delete(callId);
    this.completedCalls.unshift(event);

    // Trim history
    if (this.completedCalls.length > this.maxHistory) {
      this.completedCalls.length = this.maxHistory;
    }

    this.emit('call:end', event);

    this.writeTimelineEntry(event);
  }

  /**
   * Get all currently active (in-progress) calls
   */
  getActiveCalls(): ToolCallEvent[] {
    return Array.from(this.calls.values());
  }

  /**
   * Get recent completed calls
   */
  getRecentCalls(limit: number = 20): ToolCallEvent[] {
    return this.completedCalls.slice(0, limit);
  }

  /**
   * Get all calls (active + recent completed) for display
   */
  getAllCalls(limit: number = 20): ToolCallEvent[] {
    const active = this.getActiveCalls();
    const recent = this.getRecentCalls(limit - active.length);
    return [...active, ...recent];
  }

  /**
   * Get call by ID
   */
  getCall(callId: string): ToolCallEvent | undefined {
    return this.calls.get(callId) || this.completedCalls.find(c => c.id === callId);
  }

  /**
   * Get statistics
   */
  getStats(): {
    activeCount: number;
    totalCompleted: number;
    successCount: number;
    errorCount: number;
    avgDuration: number;
  } {
    const successCount = this.completedCalls.filter(c => c.result === 'success').length;
    const errorCount = this.completedCalls.filter(c => c.result === 'error').length;
    const totalDuration = this.completedCalls.reduce((sum, c) => sum + (c.duration || 0), 0);
    const avgDuration = this.completedCalls.length > 0
      ? totalDuration / this.completedCalls.length
      : 0;

    return {
      activeCount: this.calls.size,
      totalCompleted: this.completedCalls.length,
      successCount,
      errorCount,
      avgDuration: Math.round(avgDuration),
    };
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.calls.clear();
    this.completedCalls = [];
    this.callCounter = 0;
  }

  /**
   * Write a timeline entry via buffered async stream (best-effort, non-blocking).
   */
  private writeTimelineEntry(entry: object): void {
    if (!this.timelineStream) return;
    this.timelineBuffer.push(JSON.stringify(entry) + '\n');
    if (!this.timelineFlushTimer) {
      this.timelineFlushTimer = setTimeout(() => {
        this.flushTimeline();
      }, ActivityTracker.TIMELINE_FLUSH_INTERVAL);
    }
  }

  /**
   * Flush buffered timeline entries to the write stream.
   */
  private flushTimeline(): void {
    if (this.timelineBuffer.length > 0 && this.timelineStream) {
      const data = this.timelineBuffer.join('');
      this.timelineStream.write(data);
      this.timelineBuffer = [];
    }
    this.timelineFlushTimer = null;
  }

  /**
   * Flush pending writes and close the timeline stream. Call on shutdown.
   */
  destroy(): void {
    this.flushTimeline();
    if (this.timelineStream) {
      this.timelineStream.end();
      this.timelineStream = null;
    }
    if (this.timelineFlushTimer) {
      clearTimeout(this.timelineFlushTimer);
      this.timelineFlushTimer = null;
    }
  }
}

// Singleton instance
let instance: ActivityTracker | null = null;

export function getActivityTracker(): ActivityTracker {
  if (!instance) {
    instance = new ActivityTracker();
  }
  return instance;
}

export function setActivityTracker(tracker: ActivityTracker): void {
  instance = tracker;
}
