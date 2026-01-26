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
  toolName: string;
  sessionId: string;
  args?: Record<string, unknown>;
  startTime: number;
  endTime?: number;
  duration?: number;
  result: ToolCallResult;
  error?: string;
}

export interface DashboardStats {
  sessions: number;
  workers: number;
  tabs: number;
  queueSize: number;
  memoryUsage: number;
  uptime: number;
  status: 'running' | 'paused' | 'stopped';
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
