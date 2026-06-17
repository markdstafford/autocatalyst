import type { IssueTrackerPort } from './issue-tracker.js';

export interface IssueTrackerRegistry {
  get(provider: string): IssueTrackerPort | null;
}

export class StaticIssueTrackerRegistry implements IssueTrackerRegistry {
  readonly #adapters: Map<string, IssueTrackerPort>;

  constructor(adapters: Record<string, IssueTrackerPort>) {
    this.#adapters = new Map(
      Object.entries(adapters).map(([key, port]) => [key.toLowerCase().trim(), port])
    );
  }

  get(provider: string): IssueTrackerPort | null {
    return this.#adapters.get(provider.toLowerCase().trim()) ?? null;
  }
}
