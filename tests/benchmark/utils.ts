export function measureCall(
  result: unknown,
  args: Record<string, unknown>,
  counters: { inputChars: number; outputChars: number; toolCallCount: number },
): void {
  counters.inputChars += JSON.stringify(args).length;
  counters.outputChars += JSON.stringify(result).length;
  counters.toolCallCount += 1;
}
