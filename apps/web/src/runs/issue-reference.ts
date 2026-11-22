import type { HostRepository } from '@autocatalyst/api-contract';

export const ISSUE_LOOKUP_DEBOUNCE_MS = 300;

type IssueReference = { readonly number: number } | { readonly error: string };

const INVALID_REFERENCE = 'Enter an issue number, #number or an issue URL.';

// Match the entire spelling rather than a normalized URL: URL parsing alone
// accepts dot segments, escaped hosts, empty queries and other unsupported forms.
const ISSUE_URL = /^([a-zA-Z]+):\/\/([a-zA-Z.]+(?::\d+)?)\/([a-zA-Z\d_.-]+)\/([a-zA-Z\d_.-]+)\/issues\/(\d+)\/?$/u;

export function extractIssueReference(raw: string, repository: HostRepository): IssueReference {
  const input = raw.trim();
  const numeric = /^#?(\d+)$/u.exec(input);
  const url = numeric === null ? ISSUE_URL.exec(input) : null;
  if (url !== null && (url[1]?.toLowerCase() !== 'https' || !/^github\.com(?::0*443)?$/iu.test(url[2] ?? ''))) {
    return { error: INVALID_REFERENCE };
  }
  const number = Number(numeric?.[1] ?? url?.[5]);
  if (!Number.isSafeInteger(number) || number <= 0) return { error: INVALID_REFERENCE };
  if (url !== null) {
    const owner = url[3]?.toLowerCase();
    const name = url[4]?.toLowerCase();
    if (owner === '.' || owner === '..' || name === '.' || name === '..') return { error: INVALID_REFERENCE };
    if (repository.provider !== 'github' || owner !== repository.owner.toLowerCase() || name !== repository.name.toLowerCase()) {
      return { error: 'This issue belongs to a different repository' };
    }
  }
  return { number };
}
