import { isAbsolute, normalize, parse, relative, sep } from 'node:path';

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
      /** Absolute host-owned directories that provider tools must be unable to read or write. */
      readonly protectedHistoryRoots?: readonly string[];
      completed(handle: string): void;
    };

/** Reject ambiguous patterns and any protection that would revoke the workspace grant. */
export function protectedHistoryRoots(
  roots: readonly string[] | undefined, workspaces: readonly string[]
): readonly string[] | undefined {
  if (!roots?.length || roots.some(root => !isAbsolute(root) || normalize(root) !== root ||
      root === parse(root).root || /\p{Cc}/u.test(root) || [...'\\!*?{}[]'].some(char => root.includes(char)) ||
      workspaces.some(workspace => {
        const fromHistory = relative(root, workspace);
        const fromWorkspace = relative(workspace, root);
        const inside = (value: string) => value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep));
        return inside(fromHistory) || inside(fromWorkspace);
      }))) return undefined;
  return [...new Set(roots)];
}

/** Only a pinned native boundary that rejected before seeing the prompt may create this error. */
export class NativeResumeRefused extends Error {
  constructor(readonly decision: 'missing' | 'unsupported' | 'expired' | 'stale', readonly launched: boolean) {
    super('The native conversation could not be resumed before the prompt was accepted.');
    this.name = 'NativeResumeRefused';
  }
}
