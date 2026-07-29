/// <reference types="jest" />

import {
  areBoundaryMarkersEnabled,
  unescapeBoundaryContent,
  wrapBoundaryMarker,
} from '../../../src/core/perception/boundary-markers';

describe('boundary markers', () => {
  afterEach(() => { delete process.env.OPENCHROME_BOUNDARY_MARKERS; });

  test('wraps and escapes page-origin boundary open/close tokens', () => {
    const body = 'literal <\u200Boc:x> x </oc:page> y <oc:page z <oc:console>fake</oc:console>';
    const wrapped = wrapBoundaryMarker('page', { src: 'https://example.test/?q="x"', mode: 'dom' }, body);
    expect(wrapped).toContain('<oc:page src="https://example.test/?q=&quot;x&quot;" mode="dom">');
    expect(wrapped).toContain('<\u200B\u200Boc:x>');
    expect(wrapped).toContain('<\u200B/oc:page>');
    expect(wrapped).toContain('<\u200Boc:page');
    expect(wrapped).toContain('<\u200Boc:console>fake<\u200B/oc:console>');
    expect(wrapped.endsWith('</oc:page>')).toBe(true);
    expect(unescapeBoundaryContent(
      wrapped.slice(wrapped.indexOf('>') + 1, -'</oc:page>'.length),
    )).toBe(body);
  });

  test('honors env and per-call opt out', () => {
    expect(areBoundaryMarkersEnabled({})).toBe(true);
    expect(areBoundaryMarkersEnabled({ boundaryMarkers: false })).toBe(false);
    process.env.OPENCHROME_BOUNDARY_MARKERS = '0';
    expect(areBoundaryMarkersEnabled({})).toBe(false);
  });
});
