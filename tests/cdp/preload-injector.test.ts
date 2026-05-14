import { _resetPreloadScriptsForTests, applyRegisteredPreloads, listPreloadScriptIds, registerPreloadScript } from '../../src/cdp/preload-injector';

describe('preload injector (#838)', () => {
  afterEach(() => _resetPreloadScriptsForTests());

  test('registers scripts and applies each script once per page', async () => {
    const calls: string[] = [];
    const page = { evaluateOnNewDocument: jest.fn(async (source: string) => { calls.push(source); }) } as any;
    registerPreloadScript('pilot:test', 'window.__x=1');
    expect(listPreloadScriptIds()).toEqual(['pilot:test']);
    await applyRegisteredPreloads(page);
    await applyRegisteredPreloads(page);
    expect(calls).toEqual(['window.__x=1']);
  });

  test('rejects invalid ids', () => {
    expect(() => registerPreloadScript('../bad', 'x')).toThrow('Invalid preload script id');
  });
});
