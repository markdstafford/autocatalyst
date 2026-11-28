/** Stop waiting on abort, without leaving listeners or unobserved rejections behind. */
export async function abortable<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal === undefined) return work();
  signal.throwIfAborted();
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    const result = await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    })]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Invoke cleanup without waiting or allowing its failure to escape. */
export function detachCleanup(work: () => unknown): void {
  void Promise.resolve().then(work).catch(() => undefined);
}
