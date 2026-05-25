export type RecordedLibrary = 'openchrome' | 'playwright-mcp' | 'browser-use' | (string & {});

export type RecordedProvider = 'anthropic' | 'openai';

export interface RecordingCompetitorVersion {
  version: string;
  source: 'package-lock' | 'pip-freeze' | 'git-sha' | 'manual';
}

export interface RecordingManifest {
  schemaVersion: 'recording-corpus/v1';
  corpusId: string;
  capturedAt: string;
  operator: string;
  environment: {
    os: string;
    chromeVersion: string;
    nodeVersion?: string;
    pythonVersion?: string;
  };
  llm: {
    provider: RecordedProvider;
    model: string;
    temperature: number;
    maxSteps: number;
  };
  competitors: Record<string, RecordingCompetitorVersion>;
  redaction: {
    secretsRemoved: boolean;
    reviewedBy: string;
  };
}

export interface RecordingRun {
  taskId: string;
  library: RecordedLibrary;
  mode: 'recorded-real';
  success: boolean;
  finalPostconditionEvidence: string;
  tokens: number;
  usd: number;
  wallTimeMs: number;
  toolCalls: number;
  failureCategory: string | null;
  artifactRefs: string[];
}

export interface RecordingCorpusValidation {
  valid: boolean;
  errors: string[];
  sampleCount: number;
  libraries: string[];
  taskIds: string[];
}
