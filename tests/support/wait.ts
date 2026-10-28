/** Poll a condition with a real timer; the shared bounded wait for host tests. */
export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 8_000,
  intervalMs = 20,
): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
