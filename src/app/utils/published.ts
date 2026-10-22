/**
 * published
 * ----------
 * Display-time normalisation for archived publish dates.
 *
 * YouTube's `primary_info.published.text` can carry a status label, e.g.
 * "Premiered Jan 7, 2022" or "Published Jan 7, 2022". Older info.json archives
 * store that string verbatim, so the UI must strip the prefix at render time to
 * avoid "Published Premiered Jan 7, 2022".
 *
 * Kept in sync with stripPublishedLabel in ytjs/src/utils/archive.ts (which
 * cleans the value when a new archive is written).
 *
 * ES5/IE11 safe: String.prototype.replace with a literal regex only.
 */

const LABEL_RE = /^\s*(Premiered|Published|Streamed live|Started streaming)\s*(on\s+)?/i;

/** Returns the publish date with any leading status label removed. */
export function stripPublishedLabel(published?: string | null): string {
  return (published || '').replace(LABEL_RE, '');
}

/**
 * Builds the subline date text for an archive entry.
 * Prefers an absolute date ("Published <date> (<relative>)") and falls back to
 * the relative date alone. Returns '' when neither is available.
 */
export function formatPublished(relativeDate?: string | null, published?: string | null): string {
  const clean = stripPublishedLabel(published);
  if (clean) {
    return 'Published ' + clean + (relativeDate ? ' (' + relativeDate + ')' : '');
  }
  return relativeDate || '';
}