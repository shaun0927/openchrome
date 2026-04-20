import { log } from '../../src/observability/logger';
import { runWithRequestContext } from '../../src/observability/request-id';

describe('observability logger', () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  test('no prefix when no active request context', () => {
    log.error('hello', 123);
    expect(errSpy).toHaveBeenCalledWith('hello', 123);
  });

  test('prefixes with [req=...] when context is active', () => {
    runWithRequestContext({ requestId: 'req-xyz' }, () => {
      log.error('boom', { detail: 1 });
    });
    expect(errSpy).toHaveBeenCalledWith('[req=req-xyz]', 'boom', { detail: 1 });
  });

  test('info/warn share the same prefixing behaviour', () => {
    runWithRequestContext({ requestId: 'r1' }, () => {
      log.info('hi');
      log.warn('caution');
    });
    expect(errSpy).toHaveBeenNthCalledWith(1, '[req=r1]', 'hi');
    expect(errSpy).toHaveBeenNthCalledWith(2, '[req=r1]', 'caution');
  });
});
