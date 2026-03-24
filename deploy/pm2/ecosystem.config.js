// OpenChrome MCP Server — PM2 Ecosystem Configuration
// Install: npm install -g pm2
// Start:   pm2 start deploy/pm2/ecosystem.config.js
// Monitor: pm2 monit
// Logs:    pm2 logs openchrome

module.exports = {
  apps: [
    {
      name: 'openchrome',
      script: 'dist/index.js',
      args: 'serve --http 3100 --auto-launch --server-mode',

      // Restart policy
      autorestart: true,
      exp_backoff_restart_delay: 100, // Exponential backoff: 100ms, 200ms, 400ms...
      max_restarts: 50,               // Max restarts within restart_delay window
      min_uptime: '10s',              // Consider crashed if exits within 10s

      // Resource limits
      max_memory_restart: '500M',     // Restart if memory exceeds 500MB

      // Environment
      env: {
        NODE_ENV: 'production',
        OPENCHROME_MAX_RECONNECT_ATTEMPTS: '0',      // Infinite reconnection
        OPENCHROME_EVENT_LOOP_FATAL_MS: '30000',      // 30s fatal threshold
        OPENCHROME_RATE_LIMIT_RPM: '120',             // Rate limit
      },

      // Logging
      error_file: 'logs/openchrome-error.log',
      out_file: 'logs/openchrome-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Watch (disabled for production — enable for development)
      watch: false,
      ignore_watch: ['node_modules', 'logs', '.openchrome', '.omc'],

      // Cluster mode (single instance — Chrome connection is per-process)
      instances: 1,
      exec_mode: 'fork',
    },
  ],
};
