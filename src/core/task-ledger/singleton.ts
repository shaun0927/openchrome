import { TaskStore, defaultTaskRootDir } from './store';

let storeSingleton: TaskStore | undefined;

/** Resolve the process-wide task ledger store. */
export function getTaskStore(): TaskStore {
  if (!storeSingleton) {
    storeSingleton = new TaskStore({ rootDir: defaultTaskRootDir() });
  }
  return storeSingleton;
}

/** Test seam — override the process-wide store with a custom instance. */
export function setTaskStoreForTests(store: TaskStore | undefined): void {
  storeSingleton = store;
}
