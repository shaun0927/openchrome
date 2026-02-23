/**
 * Operation Controller - Pause/Resume/Cancel control for operations
 */

import { EventEmitter } from 'events';

export interface OperationControllerEvents {
  'paused': () => void;
  'resumed': () => void;
  'cancelled': (callId: string) => void;
}

interface PendingGate {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class OperationController extends EventEmitter {
  private _isPaused: boolean = false;
  private pendingGates: Map<string, PendingGate> = new Map();
  private cancelledCalls: Set<string> = new Set();
  private gateCounter: number = 0;

  /**
   * Check if operations are paused
   */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Pause all new operations
   */
  pause(): void {
    if (!this._isPaused) {
      this._isPaused = true;
      this.emit('paused');
    }
  }

  /**
   * Resume operations
   */
  resume(): void {
    if (this._isPaused) {
      this._isPaused = false;
      // Release all pending gates
      for (const [gateId, gate] of this.pendingGates) {
        if (!this.cancelledCalls.has(gateId)) {
          gate.resolve();
        }
      }
      this.pendingGates.clear();
      this.emit('resumed');
    }
  }

  /**
   * Toggle pause state
   */
  toggle(): boolean {
    if (this._isPaused) {
      this.resume();
    } else {
      this.pause();
    }
    return this._isPaused;
  }

  /**
   * Gate for controlling operation execution
   * Call this before executing a tool - it will wait if paused
   * @param callId Optional call ID for cancellation support
   * @returns Promise that resolves when operation can proceed
   * @throws Error if operation is cancelled
   */
  async gate(callId?: string): Promise<void> {
    // Check if already cancelled
    if (callId && this.cancelledCalls.has(callId)) {
      this.cancelledCalls.delete(callId);
      throw new Error('Operation cancelled');
    }

    // If not paused, proceed immediately
    if (!this._isPaused) {
      return;
    }

    // Wait for resume or cancellation
    const gateId = callId || `gate-${++this.gateCounter}`;

    return new Promise<void>((resolve, reject) => {
      this.pendingGates.set(gateId, { resolve, reject });

      // If cancelled while we're setting up, reject immediately
      if (this.cancelledCalls.has(gateId)) {
        this.cancelledCalls.delete(gateId);
        this.pendingGates.delete(gateId);
        reject(new Error('Operation cancelled'));
      }
    });
  }

  /**
   * Cancel a specific operation by call ID
   * If the operation is waiting at the gate, it will be rejected
   * If the operation is in progress, this just marks it for cancellation
   */
  cancel(callId: string): boolean {
    this.cancelledCalls.add(callId);

    const gate = this.pendingGates.get(callId);
    if (gate) {
      this.pendingGates.delete(callId);
      gate.reject(new Error('Operation cancelled'));
      this.emit('cancelled', callId);
      return true;
    }

    this.emit('cancelled', callId);
    return false;
  }

  /**
   * Cancel all pending operations
   */
  cancelAll(): number {
    let count = 0;
    for (const [gateId, gate] of this.pendingGates) {
      this.cancelledCalls.add(gateId);
      gate.reject(new Error('Operation cancelled'));
      count++;
    }
    this.pendingGates.clear();
    return count;
  }

  /**
   * Check if a call has been cancelled
   */
  isCancelled(callId: string): boolean {
    return this.cancelledCalls.has(callId);
  }

  /**
   * Clear cancelled status for a call ID
   */
  clearCancelled(callId: string): void {
    this.cancelledCalls.delete(callId);
  }

  /**
   * Get number of operations waiting at the gate
   */
  get pendingCount(): number {
    return this.pendingGates.size;
  }

  /**
   * Get status
   */
  getStatus(): {
    isPaused: boolean;
    pendingCount: number;
    cancelledCount: number;
  } {
    return {
      isPaused: this._isPaused,
      pendingCount: this.pendingGates.size,
      cancelledCount: this.cancelledCalls.size,
    };
  }

  /**
   * Reset controller state
   */
  reset(): void {
    this._isPaused = false;
    this.cancelAll();
    this.cancelledCalls.clear();
    this.gateCounter = 0;
  }
}

// Singleton instance
let instance: OperationController | null = null;

export function getOperationController(): OperationController {
  if (!instance) {
    instance = new OperationController();
  }
  return instance;
}

export function setOperationController(controller: OperationController): void {
  instance = controller;
}
