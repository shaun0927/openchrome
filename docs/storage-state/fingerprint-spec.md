# Profile Fingerprint Spec — v1

A *profile fingerprint* is a deterministic, secret-free hash over a captured
storage-state envelope. It lets two parties verify *"is this the same
authenticated session?"* without either party seeing the cookie or storage
values.

This document freezes the canonical form for **v1**. Any change to the
canonical form requires bumping `version` to a new integer. v1 fingerprints
remain recognizable forever.

## Inputs

The fingerprint is computed from an `EnvelopeCapture`
(`src/storage-state/storage-state-manager.ts`):

```ts
interface EnvelopeCapture {
  origin: string;
  cookies: Cookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  // userAgent and viewport are not part of v1's hash domain
}
```

`userAgent` and `viewport` are **excluded** from v1: they describe the *probe*,
not the session. If a future version needs them, it must be v2.

## Hash domain — what enters the hash

Only **shape**, never **contents**:

### Cookies

For each cookie, the hash sees:

| Field         | Source                                     |
| ------------- | ------------------------------------------ |
| `name`        | as-is                                      |
| `domain`      | as-is                                      |
| `path`        | as-is                                      |
| `httpOnly`    | coerced to boolean                         |
| `secure`      | coerced to boolean                         |
| `sameSite`    | as-is string, or `""` when missing         |
| `valueLength` | `cookie.value.length` (the value itself is never used) |
| `expiryBucket`| `Math.floor(expires / 3600) * 3600` in seconds; `-1` for session cookies and any non-finite or non-positive expiry |

Cookies are **sorted** by `(domain, name, path)` before serialization.

### Local / session storage

For each entry, the hash sees:

| Field         | Source                          |
| ------------- | ------------------------------- |
| `key`         | as-is                           |
| `valueLength` | `value.length` (value excluded) |

Entries are sorted by `key`. `localStorage` and `sessionStorage` are hashed in
separate, named sections — moving a key between them changes the fingerprint.

### Origin

`capture.origin` enters the hash directly. Origins are not secrets.
Non-string origins are normalized to `""`.

## Canonical JSON

The canonical representation is a `JSON.stringify` call **with no whitespace
argument** on a fixed-key-order object:

```json
{
  "version": 1,
  "origin": "<origin>",
  "cookies":         [ { "name", "domain", "path", "httpOnly", "secure", "sameSite", "valueLength", "expiryBucket" }, ... ],
  "localStorage":    [ { "key", "valueLength" }, ... ],
  "sessionStorage":  [ { "key", "valueLength" }, ... ]
}
```

Every nested object has a fixed key order. Every array is pre-sorted as
described above. The result is byte-identical across V8 versions and operating
systems.

## Hash function

```text
hash = lowercase-hex( SHA-256( canonical-json-utf8-bytes ) )
```

## Output shape

```ts
interface ProfileFingerprint {
  version: 1;
  algorithm: 'sha256';
  hash: string;          // 64-char lowercase hex
  breakdown: {
    cookies: number;
    localStorageKeys: number;
    sessionStorageKeys: number;
    origin: string;
  };
}
```

`breakdown` is a non-secret diagnostic aid. It is *not* signed and *not* the
authoritative identity — `hash` is.

## Invariants (codified by `tests/storage-state/fingerprint.test.ts`)

1. **Determinism** — repeated calls on the same capture produce the same hash.
2. **Value secrecy** — changing only a cookie or storage *value* (with the
   same length) never changes the hash.
3. **Length sensitivity** — changing a cookie or storage value's *length* does
   change the hash. (Length leaks roughly the same information that a
   `Content-Length` header would; this is acceptable for a session-identity
   check and required to detect substantively different sessions.)
4. **Order independence** — declaring cookies or storage keys in a different
   order yields the same hash.
5. **Bucket stability** — cookies whose `expires` falls in the same hour
   bucket fingerprint identically. Crossing a bucket boundary changes the
   hash. Session cookies (`expires <= 0` or non-finite) collapse to a single
   stable bucket.
6. **Separation** — `localStorage` and `sessionStorage` are distinct sections.
7. **Forward compatibility** — `version: 1` is the spec frozen in this file.
   Any change requires bumping the version.

## Threat model & non-goals

This fingerprint is **not** a cryptographic identifier of the session. It is a
fast, deterministic shape hash. It is acceptable for:

- comparing two captures to ask "is this the same logged-in session?"
- recording a non-secret identifier of a profile snapshot in a trace
- gating which snapshot to restore for a given lane

It is **not** acceptable for:

- authentication
- tamper detection (use a signed envelope for that — covered in B3-PR3)
- replacing the storage values themselves (the hash is not invertible, but
  short fields with low-entropy lengths can still be guessed under enough
  brute force)

## See also

- `src/storage-state/fingerprint.ts` — implementation
- `tests/storage-state/fingerprint.test.ts` — invariant tests
- #1359 §Pillar B (profile/auth reuse), §Pillar D (portable memory)
