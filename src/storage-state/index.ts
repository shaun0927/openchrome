export {
  StorageStateManager,
  type StorageState,
  type CDPClientLike,
  type EnvelopeCapture,
  type EnvelopeCaptureOptions,
  type EnvelopeApplyOptions,
  type EnvelopeApplyResult,
  captureContextEnvelopeData,
  applyContextEnvelopeData,
} from './storage-state-manager';

export {
  fingerprintEnvelope,
  FINGERPRINT_VERSION,
  FINGERPRINT_ALGORITHM,
  type ProfileFingerprint,
  type FingerprintBreakdown,
} from './fingerprint';

export {
  sealEnvelope,
  verifyEnvelope,
  ENVELOPE_VERSION,
  ENVELOPE_HMAC_ALGORITHM,
  type PortableSnapshotEnvelope,
  type VerifyResult,
  type VerifyFailureReason,
  type SealOptions,
  type VerifyOptions,
} from './envelope';
