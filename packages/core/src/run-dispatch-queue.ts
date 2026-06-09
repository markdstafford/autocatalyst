export interface RunDispatchQueueOptions {
  readonly maxConcurrent: number;
}

export class RunDispatchQueue {
  readonly #maxConcurrent: number;
  #activeCount = 0;
  readonly #queue: Array<() => void> = [];

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

  #drain(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next();
    }
  }
}
