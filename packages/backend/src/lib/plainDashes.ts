/**
 * Text VirtPilot stored before 2.13.2 (activity log entries in logs.json, the notes in each backup's
 * manifest.json) still carries long dashes, which the owner reads as machine-written. The files are left
 * as they are; what the API hands the UI goes through here, and so does anything that matches a stored
 * note by its wording ("Took a full backup - …"), so old and new text compare the same.
 *
 * The same rewrite scripts/check-dashes.mjs applies to the sources: a dash between words becomes a
 * spaced hyphen, a number range a plain hyphen, and no space is added at the start or end of a line.
 */
export function plainDashes(text: string): string {
  if (!/[—–]/.test(text)) return text;
  return text
    .replace(/(\d)[ \t]*–[ \t]*(\d)/g, '$1-$2')
    .replace(/([ \t]*)[—–]([ \t]*)/g, (m: string, lead: string, trail: string, off: number, s: string) => {
      const prev = s[off - 1];
      const next = s[off + m.length];
      const before = lead !== '' || (prev !== undefined && prev !== '\n');
      const after = trail !== '' || (next !== undefined && next !== '\n');
      return `${before ? ' ' : ''}-${after ? ' ' : ''}`;
    });
}
