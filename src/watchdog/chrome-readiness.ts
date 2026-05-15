import type { ConnectionEvent } from '../cdp/client';
import type { ComponentState } from './readiness';
import { setComponent } from './readiness';

export interface ChromeReadinessClient {
  addConnectionListener(listener: (event: ConnectionEvent) => void): void;
  /**
   * @param options.autoLaunch When `false`, do NOT spawn Chrome even if the
   *   underlying client is configured to auto-launch. Used by the readiness
   *   probe at server startup. Implementations that do not control Chrome
   *   spawning may ignore this option.
   */
  connect(options?: { autoLaunch?: boolean }): Promise<void>;
  forceReconnect(): Promise<void>;
}

export type SetChromeReadiness = (state: ComponentState) => void;

function setChromeWithDevDelay(
  state: ComponentState,
  setChrome: SetChromeReadiness,
  env: NodeJS.ProcessEnv,
): void {
  if (
    state === 'ok' &&
    env.NODE_ENV !== 'production' &&
    env.OPENCHROME_DEV_HOOKS === '1' &&
    env.OPENCHROME_FAKE_SLOW_START
  ) {
    const delayMs = parseInt(env.OPENCHROME_FAKE_SLOW_START, 10);
    if (delayMs > 0) {
      setTimeout(() => setChrome('ok'), delayMs);
      return;
    }
  }

  setChrome(state);
}

export function wireChromeReadiness(
  cdpClient: ChromeReadinessClient,
  options: {
    setChrome?: SetChromeReadiness;
    env?: NodeJS.ProcessEnv;
    log?: Pick<typeof console, 'error'>;
  } = {},
): {
  initializeStartupConnection: () => void;
  handleChromeRelaunched: () => Promise<void>;
} {
  const setChrome = options.setChrome ?? ((state) => setComponent('chrome', state));
  const env = options.env ?? process.env;
  const log = options.log ?? console;
  let relaunchReconnectInFlight = false;

  const setChromeState = (state: ComponentState) => {
    setChromeWithDevDelay(state, setChrome, env);
  };

  cdpClient.addConnectionListener((event) => {
    if (relaunchReconnectInFlight) {
      return;
    }

    if (event.type === 'connected' || event.type === 'reconnected') {
      setChromeState('ok');
    } else if (event.type === 'disconnected' || event.type === 'reconnect_failed') {
      setChromeState('failing');
    }
  });

  return {
    // Startup probe must NEVER auto-launch Chrome. Spawning belongs to actual
    // tool calls; the readiness probe should only attach to an already-running
    // Chrome so the daemon's /ready endpoint can flip to ok before the first
    // MCP tool call. Without this, every server restart (e.g. each VSCode
    // reload) would spawn an empty Chrome window even when autoLaunch is
    // enabled for tool-call code paths.
    initializeStartupConnection: () => {
      cdpClient.connect({ autoLaunch: false }).catch((err: unknown) => {
        log.error('[SelfHealing] Startup Chrome connect failed:', err);
        setChromeState('failing');
      });
    },

    handleChromeRelaunched: async () => {
      relaunchReconnectInFlight = true;
      setChromeState('failing');
      try {
        await cdpClient.forceReconnect();
        setChromeState('ok');
      } catch (err) {
        setChromeState('failing');
        throw err;
      } finally {
        relaunchReconnectInFlight = false;
      }
    },
  };
}
