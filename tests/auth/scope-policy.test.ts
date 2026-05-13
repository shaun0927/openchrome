/// <reference types="jest" />
// Tests for src/auth/scope-policy.ts — PR2 (issue #9)

import { isAllowed, requiredScope, WRITE_TOOLS, READ_TOOLS, ADMIN_TOOLS } from '../../src/auth/scope-policy';

describe('requiredScope', () => {
  it('screenshot -> read', () => {
    expect(requiredScope('page_screenshot')).toBe('read');
  });

  it('navigate -> write', () => {
    expect(requiredScope('navigate')).toBe('write');
  });

  it('unknown tool defaults to write (least-privilege fail-safe)', () => {
    // New/unclassified tools require 'write' so that composite tools added
    // after PR2 cannot be invoked by read-only keys by default.
    expect(requiredScope('some_future_tool')).toBe('write');
  });

  it('composite tools with mutating subactions require write', () => {
    // `worker` (create/delete) and `memory` (record/validate) must not be
    // reachable by read-only keys — regression guard for the Codex P1 finding.
    expect(requiredScope('worker')).toBe('write');
    expect(requiredScope('memory')).toBe('write');
  });

  it('TaskRun read-only queries are classified read (#1039)', () => {
    // oc_task_run_get and oc_task_run_list never mutate browser or run state.
    expect(requiredScope('oc_task_run_get')).toBe('read');
    expect(requiredScope('oc_task_run_list')).toBe('read');
    expect(isAllowed('oc_task_run_get', ['read'])).toBe(true);
    expect(isAllowed('oc_task_run_list', ['read'])).toBe(true);
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

  it('read-only key is denied unclassified tools (fail-safe default)', () => {
    expect(isAllowed('some_future_tool', ['read'])).toBe(false);
    expect(isAllowed('some_future_tool', ['write'])).toBe(true);
  });

  it('WRITE_TOOLS set contains expected browser-mutating tools', () => {
    expect(WRITE_TOOLS.has('navigate')).toBe(true);
    expect(WRITE_TOOLS.has('fill_form')).toBe(true);
    expect(WRITE_TOOLS.has('javascript_tool')).toBe(true);
    expect(WRITE_TOOLS.has('cookies')).toBe(true);
    expect(WRITE_TOOLS.has('interact')).toBe(true);
    expect(WRITE_TOOLS.has('worker')).toBe(true);
    expect(WRITE_TOOLS.has('memory')).toBe(true);
  });

  it('read-only tools are in READ_TOOLS and NOT in WRITE_TOOLS', () => {
    for (const t of ['page_screenshot', 'read_page', 'query_dom', 'find', 'wait_for']) {
      expect(READ_TOOLS.has(t)).toBe(true);
      expect(WRITE_TOOLS.has(t)).toBe(false);
    }
  });
});
