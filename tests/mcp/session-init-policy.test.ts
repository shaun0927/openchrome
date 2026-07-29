import { shouldInitializeBrowserSession } from '../../src/mcp/session-init-policy';

describe('MCP browser session initialization policy', () => {
  test.each([
    'expand_tools',
    'oc_connection_health',
    'oc_doctor_report',
    'oc_get_connection_info',
    'oc_devtools_url',
    'list_profiles',
    'oc_normalize_action',
    'oc_policy',
    'oc_copy_to_clipboard',
    'oc_open_host_settings',
    'memory',
    'image_qa',
    'oc_assert',
    'oc_diff',
    'oc_evidence_bundle',
    'oc_evidence_get',
    'oc_output_fetch',
    'oc_performance_analyze',
    'oc_reflect',
    'oc_skill_record',
    'oc_skill_recall',
    'oc_skill_export',
    'oc_totp_generate',
    'oc_recording_start',
    'oc_task_run_start',
    'crawl_start',
    'crawl_cancel',
    'workflow_status',
    'workflow_collect',
    'workflow_collect_partial',
    'workflow_cleanup',
    'worker_update',
    'worker_complete',
    'oc_lane_list',
    'oc_lane_get',
    'oc_lane_close',
    'oc_credentials',
    'oc_proxy_hook',
    'oc_pilot_handoff_create',
    'oc_pilot_handoff_redeem',
  ])('%s stays launch-free', (toolName) => {
    expect(shouldInitializeBrowserSession(toolName)).toBe(false);
  });

  test.each([
    'navigate',
    'tabs_activate',
    'tabs_create',
    'read_page',
    'oc_vitals',
    'oc_performance_insights',
  ])('%s requires a browser session', (toolName) => {
    expect(shouldInitializeBrowserSession(toolName)).toBe(true);
  });

  test('unknown tools default to browser-session initialization', () => {
    expect(shouldInitializeBrowserSession('future_browser_tool')).toBe(true);
  });

  test.each([
    [{ advance: 0 }, false],
    [{ advance: -1 }, false],
    [{ advance: '0' }, false],
    [{ advance: 1 }, true],
    [{ advance: '2' }, true],
    [{}, true],
    [{ advance: 'not-a-number' }, true],
  ])('crawl_status args %j require browser=%s', (args, expected) => {
    expect(shouldInitializeBrowserSession('crawl_status', args)).toBe(expected);
  });

  test.each([
    ['create', true],
    ['list', false],
    ['delete', false],
    ['unknown', false],
  ])('worker action %s requires browser=%s', (action, expected) => {
    expect(shouldInitializeBrowserSession('worker', { action })).toBe(expected);
  });
});
