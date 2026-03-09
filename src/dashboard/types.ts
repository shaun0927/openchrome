/**
 * Dashboard Type Definitions
 */

export interface DashboardConfig {
  enabled: boolean;
  refreshInterval: number;  // ms (default: 100)
  maxLogEntries: number;    // default: 50
}

export type ViewMode = 'activity' | 'sessions' | 'tabs';

export type ToolCallResult = 'success' | 'error' | 'pending';

export interface ToolCallEvent {
  id: string;
  requestId?: number | string;
  toolName: string;
  sessionId: string;
  args?: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  duration?: number;
  result: ToolCallResult;
  error?: string;
  compression?: {
    originalChars: number;
    compressedChars: number;
    estimatedTokensSaved: number;  // rough: chars / 4
    strategy: string;              // e.g., 'sibling-dedup', 'delta', 'verbosity', 'log-dedup', 'cookie-classify'
  };
}

export interface DashboardStats {
  sessions: number;
  workers: number;
  tabs: number;
  queueSize: number;
  memoryUsage: number;
  uptime: number;
  status: 'running' | 'paused' | 'stopped';
  compression?: {
    totalOriginalChars: number;
    totalCompressedChars: number;
    totalTokensSaved: number;
    compressionRatio: number;        // e.g., 0.65 = 65% reduction
    callsCompressed: number;
    topSavers: Array<{
      toolName: string;
      tokensSaved: number;
      calls: number;
    }>;
  };
}

export interface SessionInfo {
  id: string;
  workerCount: number;
  tabCount: number;
  createdAt: number;
  lastActivity: number;
}

export interface TabInfo {
  targetId: string;
  sessionId: string;
  workerId: string;
  url: string;
  title: string;
}

export interface KeyBinding {
  key: string;
  description: string;
  action: () => void;
}

export interface ScreenSize {
  columns: number;
  rows: number;
}

export const DEFAULT_CONFIG: DashboardConfig = {
  enabled: true,
  refreshInterval: 100,
  maxLogEntries: 50,
};
