/**
 * Global Configuration - Runtime settings for the MCP server
 */

export interface GlobalConfig {
  /** Chrome remote debugging port */
  port: number;
  /** Auto-launch Chrome if not running (default: false) */
  autoLaunch: boolean;
  /** Custom user data directory for Chrome (default: uses real Chrome profile on macOS, temp dir elsewhere) */
  userDataDir?: string;
  /** Path to custom Chrome binary (e.g., chrome-headless-shell) */
  chromeBinary?: string;
  /** Use chrome-headless-shell if available (default: false) */
  useHeadlessShell?: boolean;
  /** Run Chrome in headless mode (default: true when auto-launch is enabled) */
  headless?: boolean;
  /** If true, quit running Chrome to reuse the real profile instead of using temp profile (default: false) */
  restartChrome?: boolean;
  /** If true, skip cookie bridge on page creation (used in server/headless mode) */
  skipCookieBridge?: boolean;
  /** Chrome Pool settings for managing multiple Chrome instances */
  pool?: {
    /** Enable the Chrome pool (default: true) */
    enabled: boolean;
    /** Maximum number of Chrome instances in the pool (default: 5) */
    maxInstances: number;
    /** Base port for Chrome instances; subsequent instances use basePort+1, +2, etc. (default: 9222) */
    basePort: number;
  };
  /** Security settings */
  security?: {
    /** Domains to block AI agent access to. Supports glob patterns (e.g., "*.bank.com") */
    blocked_domains?: string[];
    /** Enable audit logging of tool invocations (default: false) */
    audit_log?: boolean;
    /** Custom audit log path (default: ~/.openchrome/audit.log) */
    audit_log_path?: string;
  };
  /** Hybrid mode settings (Lightpanda + Chrome routing) */
  hybrid?: {
    /** Enable hybrid mode (default: false) */
    enabled: boolean;
    /** Lightpanda debugging port (default: 9223) */
    lightpandaPort: number;
    /** Circuit breaker settings */
    circuitBreaker?: {
      maxFailures?: number;
      cooldownMs?: number;
    };
    /** Cookie sync settings */
    cookieSync?: {
      intervalMs?: number;
    };
  };
}

const config: GlobalConfig = {
  port: 9222,
  autoLaunch: false,
};

/**
 * Get global configuration
 */
export function getGlobalConfig(): GlobalConfig {
  return config;
}

/**
 * Set global configuration
 */
export function setGlobalConfig(newConfig: Partial<GlobalConfig>): void {
  Object.assign(config, newConfig);
}
