# Snapshot Trust Boundary Policy

**Scope:** govern when an openchrome host MAY accept a B3-PR3 portable
snapshot envelope (`PortableSnapshotEnvelope`) from another tenant /
host / external source, and how the trust decision composes with
#1375 (shared-profile trust policy).

This is the SSOT for the *import side* of the B3 thread. Compliant with
#1359 §P7 (no mandatory third-party credentials at boot) and §Pillar B
(profile/auth reuse).

## The three trust postures

A host that handles a portable snapshot envelope must commit to one of
three postures at the moment of import:

### Posture A — single-tenant, self-issued

- The host **sealed** the envelope itself, possibly hours or days ago.
- Import is a self-restore.
- HMAC key is optional; the fingerprint already detects shape drift.

### Posture B — multi-tenant, shared HMAC key

- Two or more openchrome hosts share an HMAC key out of band (e.g. a
  CI orchestrator distributes it).
- A host SHOULD require `hmacKey` on every signed-envelope import
  (`requireHmac: true` semantics — set explicitly).
- The fingerprint plus HMAC together detect tampering of both shape
  and values.
- The shared key MUST be treated as a credential. If it leaks, every
  envelope ever sealed with it is forgeable.

### Posture C — external / untrusted source

- The envelope arrived from outside the trust domain (uploaded by a
  user, fetched from another vendor, found in a benchmark fixture).
- The host SHOULD treat the envelope as **data, not commands**:
  - **REQUIRED**: verify the fingerprint matches the payload (the
    envelope verifier returns `fingerprint_mismatch` on any drift).
  - **REQUIRED**: never auto-apply the payload. Use the verified
    `payload` only after a separate authorization step (user confirm,
    policy check, sandbox restore).
  - **PROHIBITED**: trusting an HMAC from this source — an attacker
    holding the key can forge envelopes. Surface the HMAC field to
    the host operator as a fact, not as an authoritative signal.

## What the openchrome core enforces

The openchrome core enforces *mechanism*, not *policy*. Specifically:

1. **The fingerprint is always re-derived.** `verifyEnvelope` does
   not trust the stored hash — it recomputes from the payload. A
   payload-tampering attacker cannot pass verification by also
   swapping the stored hash, because the recompute is byte-for-byte
   identical only when shape matches.

2. **The HMAC is checked in constant time** (`crypto.timingSafeEqual`)
   when the host supplies a key. The core never reads an HMAC key
   from the environment, the filesystem, or a defaults table — the
   host must supply it on every call.

3. **`requireHmac: true` is opt-in.** Default verify accepts unsigned
   envelopes. Hosts running in posture B or C MUST set this flag to
   make the absence of an HMAC a hard fail.

4. **Apply is gated on verification success.** The
   `oc_context_import` flow short-circuits to
   `{ ok: false, integrityError }` before any cookie or storage
   mutation when verification fails. There is no "best-effort apply"
   path.

## Composition with #1375 shared-profile trust

#1375 governs whether two openchrome processes may share a single
Chrome profile under shared-profile-policy. It is a *runtime trust
decision* about the live browser.

Snapshot envelopes are a *transport-time trust decision* about
portable artifacts. The two interact at exactly one place:

> If the host's policy disallows shared-profile attach for a given
> tenant pair, the host MUST also disallow importing a snapshot
> envelope from that tenant. The envelope payload carries cookies
> for the same origin and is functionally equivalent to a
> shared-profile attach for the purposes of credential exposure.

In other words: if you wouldn't trust their Chrome, don't trust their
envelope either.

This rule lives in the host's policy layer. The openchrome core does
not auto-correlate tenants; it provides the primitives (fingerprint,
HMAC, verify result) and the host composes them with #1375.

## Recommended import recipe (Posture C)

```ts
// 1. Verify.
const r = verifyEnvelope(incoming, { hmacKey: maybeKey, requireHmac: true });
if (!r.ok) {
  return { ok: false, reason: r.reason };
}

// 2. Author-side policy check (host-defined).
if (!policy.allowSnapshotFrom(r.envelope.origin, tenantContext)) {
  return { ok: false, reason: 'policy_denied' };
}

// 3. User confirmation (host-defined, e.g. elicitation).
const confirmed = await elicit(`Import auth state for ${r.envelope.origin}?`);
if (!confirmed) return { ok: false, reason: 'user_denied' };

// 4. Apply via oc_context_import with the verified envelope.
return await applyContextEnvelope(r.envelope.payload);
```

The openchrome core supplies steps 1 and 4. Steps 2 and 3 are the
host's responsibility — this preserves #1359 §P2 (harness, not
agent).

## See also

- `src/storage-state/envelope.ts` — `sealEnvelope`, `verifyEnvelope`
- `src/storage-state/fingerprint.ts` — shape hash
- `docs/storage-state/fingerprint-spec.md` — canonical fingerprint v1
- #1359 §Pillar B (profile/auth reuse), §Pillar D (portable memory),
  §P7 (no mandatory third-party credentials at boot)
- #1375 shared-profile trust policy (composed with this policy at the
  host layer)
- `docs/security/irreversible-action-policy.md` — broader irreversible-
  action posture
