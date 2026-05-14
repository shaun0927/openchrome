import {
  buildPickedElement,
  clampBoundingBox,
  redactDomSnippet,
  synthesizeSelectors,
  validateScreenshotPng,
} from '../../../src/core/element-picker';

const ancestry = [
  { tagName: 'html', nthOfType: 1 },
  { tagName: 'body', nthOfType: 1 },
  { tagName: 'form', id: 'login', nthOfType: 1 },
  { tagName: 'input', attributes: { name: 'password' }, nthOfType: 2 },
];

describe('element picker recorder primitives (#899)', () => {
  test('synthesizes ordered selectors from ancestry and accessible metadata', () => {
    const selectors = synthesizeSelectors({ ancestry, role: 'textbox', accessibleName: 'Password', text: 'secret'.repeat(60) });
    expect(selectors.role).toBe('textbox');
    expect(selectors.accessibleName).toBe('Password');
    expect(selectors.text).toHaveLength(200);
    expect(selectors.cssPath).toBe('html:nth-of-type(1) > body:nth-of-type(1) > form#login > input[name="password"]');
    expect(selectors.xPath).toBe('/html[1]/body[1]/form[1]/input[2]');
    expect(selectors.nthOfType).toBe('html:nth-of-type(1) > body:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(2)');
  });

  test('redacts sensitive value attributes and credential-looking text in domSnippet', () => {
    const redacted = redactDomSnippet('<input name="password" value="hunter2"><a href="/?token=abc1234567890abcdef">x</a>');
    expect(redacted).toContain('value="[REDACTED]"');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc1234567890abcdef');
  });

  test('clamps screenshot bounding box at viewport edges with padding', () => {
    expect(clampBoundingBox({ x: -5, y: 10, width: 30, height: 20 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 2,
      width: 33,
      height: 36,
    });
    expect(clampBoundingBox({ x: 90, y: 90, width: 30, height: 30 }, { width: 100, height: 100 })).toEqual({
      x: 82,
      y: 82,
      width: 18,
      height: 18,
    });
  });

  test('rejects oversized screenshots with snapshot_too_large metadata', () => {
    const small = Buffer.alloc(1024).toString('base64');
    const large = Buffer.alloc(201 * 1024).toString('base64');
    expect(validateScreenshotPng(small)).toMatchObject({ ok: true, bytes: 1024 });
    expect(validateScreenshotPng(large)).toMatchObject({ ok: false, error: 'snapshot_too_large', bytes: 201 * 1024 });
  });

  test('buildPickedElement returns bounded redacted observation facts only', () => {
    const picked = buildPickedElement({
      ancestry,
      role: 'textbox',
      accessibleName: 'Password',
      boundingBox: { x: 10, y: 20, width: 30, height: 40 },
      viewport: { width: 200, height: 200 },
      domSnippet: '<input name="password" value="hunter2">',
      computedStyle: { display: 'block', color: 'red', cursor: 'text' },
      nodeRef: 'node_ref_1',
      backendNodeId: 42,
      loaderId: 'loader-1',
      pageUrl: 'https://example.test/login',
      pageTitle: 'Login',
      pickedAt: 123,
    });
    expect(picked).toMatchObject({
      nodeRef: 'node_ref_1',
      backendNodeId: 42,
      loaderId: 'loader-1',
      pickedAt: 123,
      pageUrl: 'https://example.test/login',
      pageTitle: 'Login',
    });
    expect(picked.computedStyle).toEqual({ display: 'block', cursor: 'text' });
    expect(picked.domSnippet).toContain('[REDACTED]');
    expect(picked.domSnippet).not.toContain('hunter2');
  });
});
