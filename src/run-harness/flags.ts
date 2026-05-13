/** Feature gate for the opt-in run harness. Enabled by default; set
 * OPENCHROME_RUN_HARNESS=0|false|off|no to restore pre-harness behavior. */
export function isRunHarnessEnabled(): boolean {
  const raw = process.env.OPENCHROME_RUN_HARNESS;
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}
