export interface RunDispatchQueueOptions {
  readonly maxConcurrent: number;
}

export class RunDispatchQueue {
  readonly #maxConcurrent: number;
  #activeCount = 0;
  readonly #queue: Array<() => void> = [];
  readonly #runTails = new Map<string, Promise<unknown>>();

  constructor(options: RunDispatchQueueOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
      throw new Error(`maxConcurrent must be a positive integer, got ${options.maxConcurrent}.`);
    }
    this.#maxConcurrent = options.maxConcurrent;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.#activeCount++;
        Promise.resolve()
          .then(() => work())
          .then(resolve, reject)
          .finally(() => {
            this.#activeCount--;
            this.#drain();
          });
      };
      if (this.#activeCount < this.#maxConcurrent) {
        run();
      } else {
        this.#queue.push(run);
      }
    });
  }

  enqueueForRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#runTails.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.enqueue(work));
    const tail = next.finally(() => {
      if (this.#runTails.get(runId) === tail) {
        this.#runTails.delete(runId);
      }
    });
    // Suppress unhandled rejection on the stored tail chain — callers hold `next` and handle errors there.
    tail.catch(() => undefined);
    this.#runTails.set(runId, tail);
    return next;
  }

  #drain(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next();
    }
  }
}
