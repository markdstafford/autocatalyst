/** Host-only launch handoff. Never serialize it to task inputs, events, or checkpoints. */
export type NativeConversationTurn =
  | { readonly mode: 'fresh_only'; readonly verifiedNonPersistence: boolean }
  | {
      readonly mode: 'retained';
      readonly resumeId?: string;
      /** Validate custody and the effective launch immediately before native persistence is enabled. */
      verifyLaunch(): Promise<boolean>;
      verifyAccount?(account: unknown): Promise<boolean>;
      lookupRootSession?(id: string, cwd: string): Promise<boolean>;
      readonly scopeEnvironment?: Readonly<Record<string, string>>;
      completed(handle: string): void;
    };

/** Only a pinned native boundary that rejected before seeing the prompt may create this error. */
export class NativeResumeRefused extends Error {
  constructor(readonly decision: 'missing' | 'unsupported' | 'expired' | 'stale', readonly launched: boolean) {
    super('The native conversation could not be resumed before the prompt was accepted.');
    this.name = 'NativeResumeRefused';
  }
}
