import { ELEMENT_PICK_OVERLAY_SOURCE, elementPickInstallExpression } from '../../../src/core/element-picker';

describe('element picker overlay script source (#899)', () => {
  test('is exported as a CDP Runtime.evaluate expression', () => {
    expect(elementPickInstallExpression()).toBe(ELEMENT_PICK_OVERLAY_SOURCE);
    expect(ELEMENT_PICK_OVERLAY_SOURCE.trim()).toMatch(/^\(\(\) => \{/);
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain("'__openchromeElementPick'");
  });

  test('anchors click interception so picker clicks do not reach the page', () => {
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('event.preventDefault();');
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('event.stopPropagation();');
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('event.stopImmediatePropagation');
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('pointer-events:auto');
  });

  test('anchors cancellation and teardown paths', () => {
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain("event.key === 'Escape'");
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain("error: 'timeout'");
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain("error: 'already_picking'");
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('document.removeEventListener');
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('removeNode(state.highlight)');
    expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain('removeNode(state.capture)');
  });

  test('collects bounded observation facts expected by recorder', () => {
    for (const fragment of [
      'ancestry: ancestryFor(el)',
      'cssPath: cssPathFor(el)',
      'boundingBox:',
      'computedStyle:',
      'domSnippet:',
      'pageUrl: location.href',
      'pageTitle: document.title',
    ]) {
      expect(ELEMENT_PICK_OVERLAY_SOURCE).toContain(fragment);
    }
  });
});
