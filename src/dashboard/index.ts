/**
 * Dashboard - Main controller for the terminal dashboard
 *
 * Provides real-time activity monitoring and control for the MCP server
 */

import { EventEmitter } from 'events';
import { ANSI } from './ansi.js';
import { Renderer, getRenderer } from './renderer.js';
import { KeyboardHandler, getKeyboardHandler, KeyEvent } from './keyboard-handler.js';
import { ActivityTracker, getActivityTracker } from './activity-tracker.js';
import { OperationController, getOperationController } from './operation-controller.js';
import { MainView, MainViewData } from './views/main-view.js';
import { SessionsView, SessionsViewData } from './views/sessions-view.js';
import { TabsView, TabsViewData } from './views/tabs-view.js';
import type { ViewMode, DashboardConfig, DashboardStats, SessionInfo, TabInfo, ToolCallEvent, DEFAULT_CONFIG } from './types.js';
import type { SessionManager } from '../session-manager.js';

export interface DashboardOptions {
  enabled?: boolean;
  refreshInterval?: number;
  maxLogEntries?: number;
  version?: string;
}

export class Dashboard extends EventEmitter {
  private renderer: Renderer;
  private keyboard: KeyboardHandler;
  private activityTracker: ActivityTracker;
  private operationController: OperationController;

  private mainView: MainView;
  private sessionsView: SessionsView;
  private tabsView: TabsView;

  private sessionManager: SessionManager | null = null;
  private config: DashboardOptions;
  private version: string;

  private currentView: ViewMode = 'activity';
  private selectedIndex: number = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private spinnerFrame: number = 0;
  private startTime: number = Date.now();
  private isRunning: boolean = false;

  constructor(options: DashboardOptions = {}) {
    super();

    this.config = {
      enabled: options.enabled ?? true,
      refreshInterval: options.refreshInterval ?? 100,
      maxLogEntries: options.maxLogEntries ?? 50,
    };

    this.version = options.version ?? '3.0.4';

    this.renderer = getRenderer();
    this.keyboard = getKeyboardHandler();
    this.activityTracker = getActivityTracker();
    this.operationController = getOperationController();

    this.mainView = new MainView(this.renderer);
    this.sessionsView = new SessionsView(this.renderer);
    this.tabsView = new TabsView(this.renderer);
  }

  /**
   * Set the session manager for data access
   */
  setSessionManager(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
  }

  /**
   * Get the activity tracker for tool call tracking
   */
  getActivityTracker(): ActivityTracker {
    return this.activityTracker;
  }

  /**
   * Get the operation controller for pause/resume/cancel
   */
  getOperationController(): OperationController {
    return this.operationController;
  }

  /**
   * Start the dashboard
   */
  start(): boolean {
    if (this.isRunning) {
      return true;
    }

    // Only start if stderr is a TTY
    if (!this.renderer.isTTY()) {
      console.error('[Dashboard] Not a TTY, dashboard disabled');
      return false;
    }

    // Check if keyboard is available
    if (!KeyboardHandler.isAvailable()) {
      console.error('[Dashboard] Keyboard input not available, dashboard disabled');
      return false;
    }

    // Initialize screen
    this.renderer.hideCursor();
    this.renderer.clear();

    // Start keyboard handler
    const keyboardStarted = this.keyboard.start(this.handleKey.bind(this));
    if (!keyboardStarted) {
      console.error('[Dashboard] Failed to start keyboard handler');
      this.renderer.showCursor();
      return false;
    }

    // Subscribe to activity events for refresh
    this.activityTracker.on('call:start', this.onActivityUpdate.bind(this));
    this.activityTracker.on('call:end', this.onActivityUpdate.bind(this));

    // Subscribe to operation controller events
    this.operationController.on('paused', this.onActivityUpdate.bind(this));
    this.operationController.on('resumed', this.onActivityUpdate.bind(this));

    // Start refresh timer
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, this.config.refreshInterval);
    this.refreshTimer.unref();

    this.startTime = Date.now();
    this.isRunning = true;
    this.emit('started');

    // Initial render
    this.refresh();

    return true;
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    // Stop refresh timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Stop keyboard handler
    this.keyboard.stop();

    // Remove activity tracker listeners
    this.activityTracker.removeAllListeners();

    // Remove operation controller listeners
    this.operationController.removeAllListeners();

    // Restore screen
    this.renderer.clear();
    this.renderer.showCursor();

    this.isRunning = false;
    this.emit('stopped');
  }

  /**
   * Handle keyboard input
   */
  private handleKey(event: KeyEvent): void {
    const key = event.key.toLowerCase();

    // Global keys
    if (key === 'q' || (event.ctrl && key === 'c')) {
      this.emit('quit');
      return;
    }

    // View-specific keys
    if (this.currentView === 'activity') {
      this.handleMainViewKey(key);
    } else if (this.currentView === 'sessions') {
      this.handleSessionsViewKey(key, event);
    } else if (this.currentView === 'tabs') {
      this.handleTabsViewKey(key, event);
    }

    // Refresh after key handling
    this.refresh();
  }

  private handleMainViewKey(key: string): void {
    switch (key) {
      case 'p':
        this.operationController.toggle();
        break;
      case 's':
        this.currentView = 'sessions';
        this.selectedIndex = 0;
        break;
      case 't':
        this.currentView = 'tabs';
        this.selectedIndex = 0;
        break;
      case 'c':
        this.cancelCurrentOperation();
        break;
    }
  }

  private handleSessionsViewKey(key: string, event: KeyEvent): void {
    const sessions = this.getSessions();

    switch (key) {
      case 'escape':
        this.currentView = 'activity';
        break;
      case 'up':
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case 'down':
        this.selectedIndex = Math.min(sessions.length - 1, this.selectedIndex + 1);
        break;
      case 'd':
        // Delete selected session
        if (sessions[this.selectedIndex]) {
          this.emit('delete-session', sessions[this.selectedIndex].id);
        }
        break;
    }
  }

  private handleTabsViewKey(key: string, event: KeyEvent): void {
    const tabs = this.getTabs();

    switch (key) {
      case 'escape':
        this.currentView = 'activity';
        break;
      case 'up':
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        break;
      case 'down':
        this.selectedIndex = Math.min(tabs.length - 1, this.selectedIndex + 1);
        break;
      case 'x':
        // Close selected tab
        if (tabs[this.selectedIndex]) {
          this.emit('close-tab', tabs[this.selectedIndex].targetId, tabs[this.selectedIndex].sessionId);
        }
        break;
    }
  }

  /**
   * Cancel the current operation
   */
  private cancelCurrentOperation(): void {
    const activeCalls = this.activityTracker.getActiveCalls();
    if (activeCalls.length > 0) {
      // Cancel the most recent active call
      const mostRecent = activeCalls[activeCalls.length - 1];
      this.operationController.cancel(mostRecent.id);
      this.activityTracker.endCall(mostRecent.id, 'error', 'Cancelled by user');
    }
  }

  /**
   * Refresh the display
   */
  private refresh(): void {
    if (!this.isRunning) return;

    this.spinnerFrame++;
    const size = this.renderer.getSize();

    let lines: string[];

    switch (this.currentView) {
      case 'activity':
        lines = this.mainView.render(this.getMainViewData(), size);
        break;
      case 'sessions':
        lines = this.sessionsView.render(this.getSessionsViewData(), size);
        break;
      case 'tabs':
        lines = this.tabsView.render(this.getTabsViewData(), size);
        break;
    }

    this.renderer.render(lines);
  }

  /**
   * Handle activity update event
   */
  private onActivityUpdate(): void {
    // Force refresh on activity change
    this.refresh();
  }

  /**
   * Get data for main view
   */
  private getMainViewData(): MainViewData {
    return {
      stats: this.getStats(),
      calls: this.activityTracker.getAllCalls(this.config.maxLogEntries || 50),
      version: this.version,
      spinnerFrame: this.spinnerFrame,
    };
  }

  /**
   * Get data for sessions view
   */
  private getSessionsViewData(): SessionsViewData {
    return {
      sessions: this.getSessions(),
      selectedIndex: this.selectedIndex,
      version: this.version,
    };
  }

  /**
   * Get data for tabs view
   */
  private getTabsViewData(): TabsViewData {
    return {
      tabs: this.getTabs(),
      selectedIndex: this.selectedIndex,
      version: this.version,
    };
  }

  /**
   * Get dashboard stats
   */
  private getStats(): DashboardStats {
    if (!this.sessionManager) {
      return {
        sessions: 0,
        workers: 0,
        tabs: 0,
        queueSize: this.activityTracker.getActiveCalls().length,
        memoryUsage: process.memoryUsage().heapUsed,
        uptime: Date.now() - this.startTime,
        status: this.operationController.isPaused ? 'paused' : 'running',
      };
    }

    const managerStats = this.sessionManager.getStats();
    return {
      sessions: managerStats.activeSessions,
      workers: managerStats.totalWorkers,
      tabs: managerStats.totalTargets,
      queueSize: this.activityTracker.getActiveCalls().length,
      memoryUsage: managerStats.memoryUsage,
      uptime: managerStats.uptime,
      status: this.operationController.isPaused ? 'paused' : 'running',
    };
  }

  /**
   * Get session list
   */
  private getSessions(): SessionInfo[] {
    if (!this.sessionManager) {
      return [];
    }

    const sessionInfos = this.sessionManager.getAllSessionInfos();
    return sessionInfos.map(info => ({
      id: info.id,
      workerCount: info.workerCount,
      tabCount: info.targetCount,
      createdAt: info.createdAt,
      lastActivity: info.lastActivityAt,
    }));
  }

  /**
   * Get tab list
   */
  private getTabs(): TabInfo[] {
    if (!this.sessionManager) {
      return [];
    }

    const tabs: TabInfo[] = [];
    const sessionInfos = this.sessionManager.getAllSessionInfos();

    for (const session of sessionInfos) {
      for (const worker of session.workers) {
        // Get targets for this worker
        const workerData = this.sessionManager.getWorker(session.id, worker.id);
        if (workerData) {
          for (const targetId of workerData.targets) {
            tabs.push({
              targetId,
              sessionId: session.id,
              workerId: worker.id,
              url: '', // Would need to fetch from page
              title: '',
            });
          }
        }
      }
    }

    return tabs;
  }

  /**
   * Check if dashboard is running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let instance: Dashboard | null = null;

export function getDashboard(options?: DashboardOptions): Dashboard {
  if (!instance) {
    instance = new Dashboard(options);
  }
  return instance;
}

export function setDashboard(dashboard: Dashboard): void {
  instance = dashboard;
}

// Re-export components
export { ActivityTracker, getActivityTracker, setActivityTracker } from './activity-tracker.js';
export { OperationController, getOperationController, setOperationController } from './operation-controller.js';
export { KeyboardHandler, getKeyboardHandler } from './keyboard-handler.js';
export { Renderer, getRenderer } from './renderer.js';
export * from './types.js';
export * from './ansi.js';
