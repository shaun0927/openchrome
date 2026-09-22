const pendingNavigations = new Map<string, Promise<void>>();

export async function serializeNavigation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = pendingNavigations.get(key) ?? Promise.resolve();
  const result = previous.then(action, action);
  const settled = result.then(() => undefined, () => undefined);
  pendingNavigations.set(key, settled);
  try {
    return await result;
  } finally {
    if (pendingNavigations.get(key) === settled) pendingNavigations.delete(key);
  }
}
