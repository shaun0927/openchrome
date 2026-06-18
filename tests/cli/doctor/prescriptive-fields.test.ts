import { formatReport, withPrescriptiveFields, type DoctorReport } from '../../../src/cli/doctor';

describe('doctor prescriptive fields', () => {
  test('mirrors remediation into reason and next_action for degraded checks', () => {
    const result = withPrescriptiveFields({
      id: 'chrome-port',
      title: 'CDP port 9222',
      status: 'warn',
      detail: 'Port 9222 is in use but no CDP endpoint found',
      remediation: 'Free port 9222 or set CHROME_PORT to a different port',
    });

    expect(result.reason).toContain('Port 9222 is in use');
    expect(result.next_action).toContain('Free port 9222');
    expect(result.safe_alternatives).toEqual(expect.arrayContaining([
      expect.stringContaining('different --port'),
    ]));
    expect(result.docs).toContain('docs/mcp/topologies.md');
  });

  test('preserves existing explicit structured fields', () => {
    const result = withPrescriptiveFields({
      id: 'chrome-port',
      title: 'CDP port 9222',
      status: 'warn',
      detail: 'detail',
      remediation: 'legacy remediation',
      reason: 'custom reason',
      next_action: 'custom action',
      safe_alternatives: ['custom alternative'],
      docs: ['custom.md'],
      facts: { port: 9222 },
    });

    expect(result.reason).toBe('custom reason');
    expect(result.next_action).toBe('custom action');
    expect(result.safe_alternatives).toEqual(['custom alternative']);
    expect(result.docs).toEqual(['custom.md']);
    expect(result.facts).toEqual({ port: 9222 });
  });


  test('does not attach remediation advice to ok checks', () => {
    const result = withPrescriptiveFields({
      id: 'chrome-binary',
      title: 'Chrome binary',
      status: 'ok',
      detail: 'Chrome found',
      facts: { chromeFound: true },
    });

    expect(result.reason).toBeUndefined();
    expect(result.next_action).toBeUndefined();
    expect(result.safe_alternatives).toBeUndefined();
    expect(result.docs).toBeUndefined();
    expect(result.facts).toEqual({ chromeFound: true });
  });


  test('human formatter keeps legacy Fix label when next_action mirrors remediation', () => {
    const report: DoctorReport = {
      openchromeVersion: '0.0.0-test',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      startedAt: new Date(0).toISOString(),
      diagnostics: {
        runtime: {
          runtime_topology: 'unknown',
          active_runtime_path: 'unknown',
          facts: {
            port: 9222,
            userDataDir: '~/.openchrome/profile',
            controllerRole: 'unlocked',
            lockPath: '~/.openchrome/locks/test.lock',
            autoElectEnabled: false,
            unsafeSharedAttachEnabled: false,
          },
        },
      },
      results: [{
        id: 'chrome-port',
        title: 'CDP port 9222',
        status: 'warn',
        detail: 'busy',
        remediation: 'Free port 9222',
        next_action: 'Free port 9222',
        durationMs: 1,
      }],
      summary: { ok: 0, warn: 1, fail: 0, skip: 0 },
      exitCode: 1,
    };

    const formatted = formatReport(report, true);
    expect(formatted).toContain('Fix: Free port 9222');
    expect(formatted).not.toContain('Next: Free port 9222');
  });

  test('duplicate-controller advice keeps unsafe shared attach as a non-default debug escape', () => {
    const result = withPrescriptiveFields({
      id: 'duplicate-controllers',
      title: 'Duplicate OpenChrome controllers',
      status: 'warn',
      detail: 'duplicate controller group detected',
      remediation: 'Use one direct controller per port/profile',
    });

    expect(result.safe_alternatives?.join('\n')).toContain('--allow-unsafe-shared-attach');
    expect(result.safe_alternatives?.join('\n')).toContain('not selected by default');
    expect(result.safe_alternatives?.slice(0, 2).join('\n')).toContain('--allow-unsafe-shared-attach');
  });
});
