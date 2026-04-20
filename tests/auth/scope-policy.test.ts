/// <reference types="jest" />
// Tests for src/auth/scope-policy.ts — PR2 (issue #9)

import { isAllowed, requiredScope, WRITE_TOOLS, ADMIN_TOOLS } from '../../src/auth/scope-policy';

describe('requiredScope', () => {
  it('screenshot -> read', () => {
    expect(requiredScope('page_screenshot')).toBe('read');
  });

  it('navigate -> write', () => {
    expect(requiredScope('navigate')).toBe('write');
  });

  it('unknown tool defaults to read', () => {
    expect(requiredScope('some_future_tool')).toBe('read');
  });

  it('admin tools -> admin (empty set returns read for now)', () => {
    // ADMIN_TOOLS is empty in PR2; any call falls through to write/read
    expect(ADMIN_TOOLS.size).toBe(0);
  });
});

describe('isAllowed', () => {
  // read-only principal
  it('screenshot allowed with [read]', () => {
    expect(isAllowed('page_screenshot', ['read'])).toBe(true);
  });

  it('navigate denied with [read]', () => {
    expect(isAllowed('navigate', ['read'])).toBe(false);
  });

  it('navigate allowed with [write]', () => {
    expect(isAllowed('navigate', ['write'])).toBe(true);
  });

  it('admin implies all tools allowed', () => {
    expect(isAllowed('navigate', ['admin'])).toBe(true);
    expect(isAllowed('page_screenshot', ['admin'])).toBe(true);
    expect(isAllowed('javascript_tool', ['admin'])).toBe(true);
  });

  it('empty scopes denies everything', () => {
    expect(isAllowed('page_screenshot', [])).toBe(false);
    expect(isAllowed('navigate', [])).toBe(false);
  });

  it('write implies read tools are also allowed', () => {
    expect(isAllowed('page_screenshot', ['write'])).toBe(true);
  });

  it('WRITE_TOOLS set contains expected browser-mutating tools', () => {
    expect(WRITE_TOOLS.has('navigate')).toBe(true);
    expect(WRITE_TOOLS.has('fill_form')).toBe(true);
    expect(WRITE_TOOLS.has('javascript_tool')).toBe(true);
    expect(WRITE_TOOLS.has('cookies')).toBe(true);
    expect(WRITE_TOOLS.has('interact')).toBe(true);
  });

  it('read-only tools are NOT in WRITE_TOOLS', () => {
    expect(WRITE_TOOLS.has('page_screenshot')).toBe(false);
    expect(WRITE_TOOLS.has('read_page')).toBe(false);
    expect(WRITE_TOOLS.has('query_dom')).toBe(false);
    expect(WRITE_TOOLS.has('find')).toBe(false);
    expect(WRITE_TOOLS.has('wait_for')).toBe(false);
  });
});
