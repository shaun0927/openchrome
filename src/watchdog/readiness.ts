/**
 * Readiness State Machine — tracks per-component startup/health state.
 * Used by the /ready HTTP endpoint to report whether the process is ready
 * to serve MCP traffic.
 *
 * Part of #862: /ready HTTP probe for container/k8s deployments.
 */

export type ReadyComponent = 'chrome' | 'tools' | 'watchdogs';
export type ComponentState = 'starting' | 'ok' | 'failing';

export interface ReadinessStatus {
  ready: boolean;
  components: Record<ReadyComponent, ComponentState>;
  /** Components that are not 'ok' and are required. Only present when ready=false. */
  blockers?: ReadyComponent[];
}

const ALL_COMPONENTS: ReadyComponent[] = ['chrome', 'tools', 'watchdogs'];

/**
 * Parse the OPENCHROME_READY_REQUIRES env var (CSV) into a set of required
 * components. Falls back to all three components when unset or empty.
 */
function parseRequiredComponents(envVal: string | undefined): Set<ReadyComponent> {
  if (!envVal || !envVal.trim()) {
    return new Set(ALL_COMPONENTS);
  }
  const parsed = envVal
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ReadyComponent => (ALL_COMPONENTS as string[]).includes(s));
  return parsed.length > 0 ? new Set(parsed) : new Set(ALL_COMPONENTS);
}

export class ReadinessMachine {
  private readonly state: Record<ReadyComponent, ComponentState> = {
    chrome: 'starting',
    tools: 'starting',
    watchdogs: 'starting',
  };

  private readonly required: Set<ReadyComponent>;

  constructor(requiredEnv?: string) {
    this.required = parseRequiredComponents(
      requiredEnv ?? process.env.OPENCHROME_READY_REQUIRES,
    );
  }

  /** Transition a component to a new state. */
  setComponent(name: ReadyComponent, state: ComponentState): void {
    this.state[name] = state;
  }

  /** Get the current state of a component. */
  getComponent(name: ReadyComponent): ComponentState {
    return this.state[name];
  }

  /** Compute the full readiness status. */
  getReadiness(): ReadinessStatus {
    const components: Record<ReadyComponent, ComponentState> = { ...this.state };
    const blockers: ReadyComponent[] = [];
    for (const comp of this.required) {
      if (components[comp] !== 'ok') {
        blockers.push(comp);
      }
    }
    const ready = blockers.length === 0;
    const result: ReadinessStatus = { ready, components };
    if (!ready) {
      result.blockers = blockers;
    }
    return result;
  }

  /** The set of required components (for inspection in tests). */
  getRequired(): Set<ReadyComponent> {
    return new Set(this.required);
  }
}

// ─── Process-wide singleton ──────────────────────────────────────────────────

let _instance: ReadinessMachine | null = null;

export function getReadinessMachine(): ReadinessMachine {
  if (!_instance) {
    _instance = new ReadinessMachine();
  }
  return _instance;
}

/**
 * Replace the singleton. Used in tests to inject a fresh instance with
 * controlled OPENCHROME_READY_REQUIRES values.
 */
export function setReadinessMachine(machine: ReadinessMachine): void {
  _instance = machine;
}

/** Reset the singleton (for test teardown). */
export function resetReadinessMachine(): void {
  _instance = null;
}

/** Convenience wrapper around the singleton. */
export function setComponent(name: ReadyComponent, state: ComponentState): void {
  getReadinessMachine().setComponent(name, state);
}
