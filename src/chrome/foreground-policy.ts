export class ForegroundPolicyError extends Error {
  readonly code = 'FOREGROUND_NOT_ALLOWED';
  constructor() { super('Foreground display is disabled by OPENCHROME_FOCUS_POLICY. Continue in background or change the server policy explicitly.'); }
}

export function assertForegroundAllowed(): void {
  const policy = process.env.OPENCHROME_FOCUS_POLICY ?? 'explicit-only';
  if (policy !== 'explicit-only') throw new ForegroundPolicyError();
}
