import type { ConnectionEvent } from '../cdp/client';
import type { ComponentState } from './readiness';
import { setComponent } from './readiness';

export interface ChromeReadinessClient {
  addConnectionListener(listener: (event: ConnectionEvent) => void): void;
  connect(): Promise<void>;
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
    initializeStartupConnection: () => {
      cdpClient.connect().catch((err: unknown) => {
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
