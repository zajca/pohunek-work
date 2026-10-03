// Branch name of a launched issue: `<prefix>/<KEY>/<slug>`.

/** Linear identifiers: team key, dash, number. */
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

/** Lowercase ASCII words of the title joined by `-`, cut to `maxLength`; empty when no ASCII letter or digit remains. */
export function slugify(title: string, maxLength: number): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.slice(0, maxLength).replace(/-+$/, "");
}
