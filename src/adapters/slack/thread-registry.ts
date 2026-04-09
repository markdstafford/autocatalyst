export class ThreadRegistry {
  private readonly map = new Map<string, string>();

  register(thread_ts: string, idea_id: string): void {
    this.map.set(thread_ts, idea_id);
  }

  resolve(thread_ts: string): string | undefined {
    return this.map.get(thread_ts);
  }
}
