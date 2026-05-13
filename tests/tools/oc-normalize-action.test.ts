/// <reference types="jest" />

import { MCPServer } from '../../src/mcp-server';
import { normalizeActionPayload, registerOcNormalizeActionTool, splitKeyChord } from '../../src/tools/oc-normalize-action';

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('oc_normalize_action', () => {
  test('registers as a side-effect-free tool', async () => {
    const server = new MCPServer({} as any);
    registerOcNormalizeActionTool(server);
    expect(server.getToolNames()).toContain('oc_normalize_action');
    const handler = server.getToolHandler('oc_normalize_action')!;
    const result = parse(await handler('default', { action: { type: 'left_click', coordinate: [100, 200] } }));
    expect(result.ok).toBe(true);
    expect(result.normalized).toMatchObject({ type: 'click', button: 'left', x: 100, y: 200 });
  });

  test('normalizes left_click coordinate tuple to click with left button', () => {
    const result = normalizeActionPayload({ action: { type: 'left_click', coordinate: [100, 200] } });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.normalized).toEqual({ type: 'click', button: 'left', x: 100, y: 200 });
    expect(result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['renamed_click_action', 'renamed_coordinate']));
  });

  test('normalizes right_click to click with right button', () => {
    const result = normalizeActionPayload({ action: { type: 'right_click', x: 10, y: 20 } });
    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual({ type: 'click', button: 'right', x: 10, y: 20 });
  });

  test('normalizes hotkey chord to keypress keys array', () => {
    expect(splitKeyChord('Ctrl-L')).toEqual(['Ctrl', 'L']);
    const result = normalizeActionPayload({ action: { type: 'hotkey', keys: 'Ctrl-L' } });
    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual({ type: 'keypress', keys: ['Ctrl', 'L'] });
  });

  test('normalizes press key alias', () => {
    const result = normalizeActionPayload({ action: { type: 'press', key: 'Enter' } });
    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual({ type: 'keypress', keys: ['Enter'] });
  });

  test('infers click and type actions', () => {
    expect(normalizeActionPayload({ action: { button: 'left', x: 1, y: 2 } }).normalized)
      .toEqual({ button: 'left', x: 1, y: 2, type: 'click' });
    expect(normalizeActionPayload({ action: { text: 'abc' } }).normalized)
      .toEqual({ text: 'abc', type: 'type' });
  });

  test('defaults click button to left', () => {
    const result = normalizeActionPayload({ action: { type: 'click', x: 1, y: 2 } });
    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual({ type: 'click', x: 1, y: 2, button: 'left' });
  });

  test('drops unknown fields with warnings and does not mutate original input', () => {
    const action = { type: 'click', x: 1, y: 2, debug: 'noise' };
    const result = normalizeActionPayload({ action });
    expect(action).toHaveProperty('debug', 'noise');
    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual({ type: 'click', x: 1, y: 2, button: 'left' });
    expect(result.warnings.some((w) => w.code === 'dropped_unknown_field' && w.path === 'action.debug')).toBe(true);
  });

  test('strict:false downgrades missing required fields to warnings but marks non-executable', () => {
    const result = normalizeActionPayload({ action: { type: 'click', x: 1 }, strict: false });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('missing_required_field');
    expect(result.safety.executableByOpenChrome).toBe(false);
  });

  test('reports errors for invalid and unsupported shapes', () => {
    expect(normalizeActionPayload({ action: null }).ok).toBe(false);
    const unsupported = normalizeActionPayload({ action: { type: 'file_upload', path: '/tmp/x' } });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.errors.map((e) => e.code)).toContain('unsupported_type');
    const missing = normalizeActionPayload({ action: { type: 'click', x: 1 } });
    expect(missing.ok).toBe(false);
    expect(missing.errors.map((e) => e.code)).toContain('missing_required_field');
  });

  test('flags destructive or irreversible labels for user confirmation', () => {
    const result = normalizeActionPayload({ action: { type: 'click', label: 'Delete account', x: 10, y: 20 } });
    expect(result.ok).toBe(true);
    expect(result.safety.requiresUserConfirmation).toBe(true);
    expect(result.safety.executableByOpenChrome).toBe(false);
    expect(result.safety.reason).toContain('delete');
  });

  test('redactNormalized hides caller-provided string payloads', () => {
    const result = normalizeActionPayload({ action: { text: 'super-secret-fixture-password' }, redactNormalized: true });
    expect(JSON.stringify(result)).not.toContain('super-secret-fixture-password');
    expect(result.normalized).toEqual({ text: '[REDACTED]', type: 'type' });
  });

  test('without redactNormalized normalized output documents caller payload echo', () => {
    const result = normalizeActionPayload({ action: { text: 'hello' } });
    expect(result.normalized).toEqual({ text: 'hello', type: 'type' });
  });

  test('wire-format invariant: content JSON equals structuredContent', async () => {
    const server = new MCPServer({} as any);
    registerOcNormalizeActionTool(server);
    const handler = server.getToolHandler('oc_normalize_action')!;
    const result: any = await handler('default', { action: { type: 'hotkey', keys: 'Ctrl-L' } });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});
