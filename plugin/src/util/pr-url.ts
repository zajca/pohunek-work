// GitHub pull request URLs reach pohunek in several spellings: the Linear attachment of an issue
// may carry a trailing slash, a tab suffix such as `/files`, a query, a fragment or other letter
// case, while the pull request itself is listed by its plain URL.

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits|checks)(?:\/[^?#]*)?|\/)?(?:[?#].*)?$/i;

/**
 * The canonical form `https://github.com/<owner>/<repo>/pull/<n>`, fully lower case, of a pull
 * request URL over https on github.com, optionally with a trailing slash, a `/files`, `/commits`
 * or `/checks` suffix (with any deeper path), a query and a fragment. Any other URL is null.
 */
export function canonicalPullRequestUrl(url: string): string | null {
  const match = PULL_REQUEST_URL.exec(url);
  if (match === null) {
    return null;
  }
  return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`.toLowerCase();
}

/** Two URLs name the same pull request when their canonical forms are equal, else when they are the same string. */
export function samePullRequestUrl(a: string, b: string): boolean {
  const canonicalA = canonicalPullRequestUrl(a);
  const canonicalB = canonicalPullRequestUrl(b);
  return canonicalA === null || canonicalB === null ? a === b : canonicalA === canonicalB;
}
