/**
 * Activity Tracker - Tracks tool calls and their execution
 */

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

  constructor(maxHistory: number = 100) {
    super();
    this.maxHistory = maxHistory;
  }

  /**
   * Start tracking a tool call
   * @returns callId for tracking
   */
  startCall(
    toolName: string,
    sessionId: string,
    args?: Record<string, unknown>
  ): string {
    const callId = `call-${Date.now()}-${++this.callCounter}`;

    const event: ToolCallEvent = {
      id: callId,
      toolName,
      sessionId,
      args,
      startTime: Date.now(),
      result: 'pending',
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
