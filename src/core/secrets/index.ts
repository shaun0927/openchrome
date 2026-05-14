/**
 * Public surface of the secrets module (#834).
 *
 * Two entry points run on the request hot path:
 *   • `substituteSecrets()` — request-argument deserialization in
 *     `src/mcp-server.ts` (whitelisted sites only).
 *   • `redactSecrets()` — tool-response serialization, trace write,
 *     skill record, journal output.
 *
 * The loader exposes a process-wide singleton populated once from
 * `--secrets <path>` in `src/index.ts`.
 */

export {
  loadSecretsFromFile,
  parseDotenv,
  makeSecretStore,
  getSecretStore,
  setSecretStore,
  SecretLoadError,
  EMPTY_SECRET_STORE,
  MAX_SECRETS,
} from './loader';
export type { SecretStore } from './loader';

export { redactSecrets, redactSecretString, findLiteralSecret } from './redactor';

export {
  substituteSecrets,
  substituteString,
  hasSecretToken,
  MissingSecretError,
  SECRET_TOKEN_RE,
} from './substituter';
