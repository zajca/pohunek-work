// A refresh requested while a read is in flight waits for exactly one follow-up read, which starts only
// after the in-flight read has finished. Every request made meanwhile shares that follow-up.

export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const read: Promise<void> = run().finally(() => {
      if (current === read) current = null;
    });
    current = read;
    return read;
  };
  return () => {
    if (current === null) return start();
    if (queued === null) {
      queued = current.then(() => {
        queued = null;
        return start();
      });
    }
    return queued;
  };
}
