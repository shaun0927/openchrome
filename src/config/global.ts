/**
 * Global Configuration - Runtime settings for the MCP server
 */

export interface GlobalConfig {
  /** Chrome remote debugging port */
  port: number;
  /** Auto-launch Chrome if not running (default: false) */
  autoLaunch: boolean;
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
