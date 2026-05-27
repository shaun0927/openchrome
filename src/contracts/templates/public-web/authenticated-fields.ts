/**
 * public-web.authenticated-fields — outcome contract template
 * (A2-PR5 of #1359).
 *
 * Declares the canonical schema for *post-authentication profile-field
 * extraction* — the hard-track task family that exercises real-Chrome
 * profile/auth reuse (#1359 §Pillar B).
 *
 * The schema separates three concerns:
 *
 *   - **Gate fact** — the host's pre-extraction read from
 *     oc_gate_inspect (or a hand-constructed fact when the host knows
 *     the gate by other means). The schema mirrors the closed
 *     `kind`/`gateType` vocabulary so the diff can verify the host
 *     reasoned about the gate before extracting.
 *   - **Auth posture** — whether authentication was achieved and how
 *     (cached-cookies vs interactive vs host-injected). The host
 *     decides what counts as success; the schema only confirms the
 *     posture was observed.
 *   - **Profile fields** — the canonical post-login shape every
 *     gated workflow surfaces: { userId, displayName, email,
 *     emailVerified, plan? }. Hosts that need additional fields
 *     clone the template inline and add them.
 *
 * The template **does not** bundle credentials, solver keys, or any
 * heuristic for how to authenticate. Per #1359 §P7 the host owns the
 * decision of how to clear the gate; the template only verifies the
 * post-clear state is well-formed.
 *
 * Wire format is schema-diff.v1.
 */

import type { OutcomeTemplate } from '../types';

export const AUTHENTICATED_FIELDS_TEMPLATE: OutcomeTemplate = {
  id: 'public-web.authenticated-fields',
  version: 1,
  description:
    'Tier-2 post-authentication profile-field extraction: gate-cleared ' +
    'posture, gate fact reference, and canonical profile fields ' +
    '(userId / displayName / email). The host owns gate-clearing; the ' +
    'schema verifies the post-clear state is well-formed.',
  tags: ['public-web', 'auth', 'profile', 'tier-2'],
  targetSchema: {
    format: 'schema-diff.v1',
    definition: {
      version: 1,
      fields: [
        // ── Auth posture ──────────────────────────────────────────────
        // Required: the host MUST tell us whether authentication was
        // achieved before claiming the rest of the fields are
        // post-login state. `false` means the rest of the snapshot is
        // pre-login.
        { name: 'authenticated', type: 'boolean' },

        // How the host believes authentication was reached.
        // 'cached-cookies' | 'interactive' | 'host-injected' | 'unknown'
        { name: 'authMethod', type: 'string' },

        // ── Gate fact reference ───────────────────────────────────────
        // The host's pre-extraction read of oc_gate_inspect (or an
        // equivalent hand-constructed fact). Required so the diff can
        // confirm the host reasoned about the gate.
        { name: 'gate.detected', type: 'boolean' },

        // The closed `kind` vocabulary from oc_gate_inspect (B2-PR1/PR2).
        // 'captcha' | 'sso' | 'paywall' | '2fa'. Absent when
        // gate.detected === false (treat with `required: false`).
        { name: 'gate.kind', type: 'string', required: false },
        { name: 'gate.gateType', type: 'string', required: false },

        // ── Profile fields (post-login canonical shape) ───────────────
        { name: 'profile.userId', type: 'string' },
        { name: 'profile.displayName', type: 'string' },
        { name: 'profile.email', type: 'string' },

        // Optional but commonly available
        { name: 'profile.emailVerified', type: 'boolean', required: false },
        { name: 'profile.plan', type: 'string', required: false },
        { name: 'profile.avatarUrl', type: 'string', required: false },
        { name: 'profile.locale', type: 'string', required: false },

        // ── Page identity (so the bundle can correlate with page-meta) ─
        { name: 'url', type: 'string' },
      ],
    },
  },
};
