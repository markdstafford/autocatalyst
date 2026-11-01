/** Result of the Chromium preflight decision. */
export interface BrowserCheckResult {
  /** True when a Chromium executable is present on disk. */
  readonly ok: boolean;
  /** Process exit code: 0 when present, 1 when missing. */
  readonly code: number;
  /** Install hint when missing; empty string when present. */
  readonly message: string;
}

/**
 * Pure decision for the preflight. Both inputs are optional so the real check
 * reads `chromium.executablePath()` and the filesystem, while tests inject a
 * path and an existence result.
 */
export declare function checkBrowser(input?: {
  executablePath?: string;
  exists?: boolean;
}): BrowserCheckResult;
