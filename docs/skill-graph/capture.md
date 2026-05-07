# DOM snapshot capture procedure for skill-graph fixtures

This procedure produces the deterministic fixtures consumed by:

- `tests/skill/state.test.ts` — state-hash stability
- `tests/skill/state.stability.test.ts` (planned) — `≥ 19 / 20` hash matches
  across captured Amazon variants
- `tests/fixtures/skill/amazon-cart-variants/` (planned) — corpus of
  20 captured DOM snapshots with intentional dynamic content variation

It is intentionally manual — capturing in CI risks tripping anti-bot on
real sites and violates ToS for some targets.

## When to recapture

Recapture the fixture set when **any** of the following changes:

- `src/skill/state.ts` hashing algorithm (bump `hash_components_version`).
- `src/skill/url-normalizer.ts` `TRACKING_PARAM_PATTERNS`.
- `src/skill/interactive-filter.ts` predicate set.
- A target site (e.g., Amazon) ships a layout change that pushes the
  fixture stability rate below 95 %.

Otherwise the existing fixtures are stable for the lifetime of v1 of the
hash algorithm.

## Procedure

### 1. Open Chrome with the project's profile

```bash
oc serve --headed --profile-directory "Default"
# In a second shell, attach DevTools to the running Chrome.
```

### 2. Navigate to the target page

For each capture, vary one or more of these dimensions to exercise the
"noise" the hasher should ignore:

| Variation | What you change | What the hash should do |
|---|---|---|
| Timestamp / nonce | revisit the same URL minutes apart | unchanged |
| Ad rotation | reload with cache disabled | unchanged |
| Tracking params | append `?utm_source=test` | unchanged |
| Logged-out / in | sign out and revisit | **change** |
| Cart state | add an item then revisit | **change** |
| Captcha challenge | visit through a VPN that triggers a challenge | **change** |

### 3. Capture the snapshot

In the DevTools Console of the captured tab, paste the snapshot script:

```js
(async () => {
  // Interactive nodes (must match src/skill/interactive-filter.ts).
  const INTERACTIVE_TAGS = new Set([
    'a','button','input','select','textarea','option','summary','video','audio',
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button','link','tab','menuitem','checkbox','radio','switch','option',
    'combobox','searchbox','textbox','slider','spinbutton',
    'menuitemcheckbox','menuitemradio',
  ]);
  function tagPath(el) {
    const parts = [];
    while (el && el !== document.body) {
      parts.unshift(el.tagName.toLowerCase());
      el = el.parentElement;
    }
    parts.unshift('body');
    return parts.join('>');
  }
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return Boolean(el.getAttribute('href'));
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return true;
    const ti = parseInt(el.getAttribute('tabindex') ?? '', 10);
    if (Number.isFinite(ti) && ti >= 0) return true;
    return false;
  }
  const interactives = [...document.querySelectorAll('*')]
    .filter(isInteractive)
    .map((el) => ({
      tagName: el.tagName.toLowerCase(),
      tagPath: tagPath(el),
      role: el.getAttribute('role') || undefined,
      hasHref: el.tagName === 'A' ? Boolean(el.getAttribute('href')) : undefined,
    }));
  const headings = [...document.querySelectorAll('h1, h2, h3')].map((h) => h.innerText);
  const landmarks = {
    loginForm: Boolean(document.querySelector('input[type=password]')),
    paymentFields: Boolean(document.querySelector('input[autocomplete*=cc-]')),
    cartBadge: Boolean(document.querySelector('[data-testid*=cart-count], #nav-cart-count')),
    modalOverlay: Boolean(document.querySelector('[role=dialog], [aria-modal=true]')),
    captchaChallenge: Boolean(document.querySelector('[data-sitekey], iframe[src*=hcaptcha], iframe[src*=cf-challenge]')),
  };
  const snapshot = { url: location.href, interactives, headings, landmarks };
  copy(JSON.stringify(snapshot, null, 2));
  console.log('snapshot copied to clipboard');
})();
```

### 4. Save the JSON

Paste the clipboard contents into:

```
tests/fixtures/skill/<scenario>/<NN>.json
```

Where:

- `<scenario>` matches the dimension you varied (e.g.
  `amazon-cart-variants`, `amazon-login-states`).
- `<NN>` is a zero-padded sequence number per scenario.

Commit the file alongside any test changes that consume it. Fixtures are
small (≈ 5–30 KB JSON) and live under version control.

### 5. Update the consumer test

For a stability scenario:

```ts
test('hash stability — 19 of 20 must match the canonical hash', () => {
  const fixtures = fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json'));
  expect(fixtures).toHaveLength(20);
  const hashes = fixtures.map((f) => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8'));
    return computeStateHash(snapshot).hash;
  });
  const dominant = mode(hashes);
  const matches = hashes.filter((h) => h === dominant).length;
  expect(matches).toBeGreaterThanOrEqual(19);
});
```

For a sensitivity scenario, assert two scenarios produce **different**
hashes:

```ts
test('logged-out vs logged-in produce distinct hashes', () => {
  const a = computeStateHash(loadFixture('amazon-login-states/00.json')).hash;
  const b = computeStateHash(loadFixture('amazon-login-states/01.json')).hash;
  expect(a).not.toBe(b);
});
```

## Recapture cadence

Re-run this procedure every 6 months, or when stability drops below the
acceptance threshold. Record the recapture date in
`docs/skill-graph/CAPTURE-LOG.md` so future maintainers can correlate
fixture age with site changes.
