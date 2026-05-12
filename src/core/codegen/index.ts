/**
 * Codegen barrel for issue #836.
 */

export {
  CodegenAggregator,
  defaultCodegenDir,
  getCodegenAggregator,
  installCodegenShutdownHooks,
  parseCodegenFormat,
  setCodegenAggregator,
} from './aggregator';
export type { CodegenFormat, CodegenAggregatorOptions, ReplayRecord } from './aggregator';

export {
  PUPPETEER_FILE_HEADER,
  PUPPETEER_FILE_FOOTER,
  PUPPETEER_SUPPORTED_TOOLS,
  formatPuppeteer,
} from './formatters/puppeteer';

export {
  PLAYWRIGHT_FILE_HEADER,
  PLAYWRIGHT_FILE_FOOTER,
  PLAYWRIGHT_SUPPORTED_TOOLS,
  formatPlaywright,
} from './formatters/playwright';

export {
  MCP_REPLAY_FILE_HEADER,
  MCP_REPLAY_FILE_FOOTER,
  formatMcpReplay,
} from './formatters/mcp-replay';

export {
  getOriginalArgs,
  getSecretsHook,
  setSecretsHook,
} from './secrets-hook';
export type { SecretsHook } from './secrets-hook';
