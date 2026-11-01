/**
 * Bearer-token store.
 *
 * The bearer token is secret material, not a preference: it lives under its own
 * localStorage key (`autocatalyst.bearerToken`), separate from
 * `autocatalyst.preferences`, so a future desktop wrapper can replace it with
 * keychain storage without touching preferences. See `apps/web/README.md`.
 *
 * Browser storage is untrusted and may be blocked (private mode, disabled
 * cookies, quota). Every access is wrapped in try/catch and falls back to an
 * in-memory value for the session. There is deliberately **no** component-facing
 * API that returns the token for display — the SDK client provider is the only
 * consumer of `readBearerToken`, and it uses the token to build the client, never
 * to render it. The token must never appear in URLs, logs, thrown messages, or
 * the DOM.
 */
export const BEARER_TOKEN_STORAGE_KEY = 'autocatalyst.bearerToken';

/** Session fallback used only when localStorage is unavailable. */
let memoryToken: string | undefined;

/**
 * Read the current bearer token, or `undefined` when none is stored. Internal to
 * the client provider — not a display API.
 */
export function readBearerToken(): string | undefined {
  try {
    const raw = window.localStorage.getItem(BEARER_TOKEN_STORAGE_KEY);
    return raw ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

/** Store the bearer token, falling back to memory when storage is blocked. */
export function writeBearerToken(token: string): void {
  try {
    window.localStorage.setItem(BEARER_TOKEN_STORAGE_KEY, token);
    // Storage succeeded, so the memory shadow is no longer needed.
    memoryToken = undefined;
  } catch {
    memoryToken = token;
  }
}

/** Clear the bearer token from both storage and the memory fallback. */
export function clearBearerToken(): void {
  memoryToken = undefined;
  try {
    window.localStorage.removeItem(BEARER_TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clear in storage; the memory fallback is already cleared.
  }
}

/** Whether a bearer token is currently available. */
export function hasBearerToken(): boolean {
  return readBearerToken() !== undefined;
}
