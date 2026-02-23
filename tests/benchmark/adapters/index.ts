/**
 * Benchmark Adapters barrel file
 * Re-exports all adapter implementations for convenient import.
 */

// Stub adapter (for CI / deterministic testing)
export {
  OpenChromeStubAdapter,
  OpenChromeAdapter, // backward compat alias
  OpenChromeAdapterOptions,
} from './openchrome-adapter';

// Real adapter (for actual performance benchmarking)
export {
  OpenChromeRealAdapter,
  RealAdapterOptions,
} from './openchrome-real-adapter';
