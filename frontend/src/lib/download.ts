/**
 * Hand a generated text document to the browser as a download.
 *
 * Shared by the post-incident debrief and the shift handover brief, which
 * are different documents with the same delivery problem.
 */

/**
 * The object URL is revoked on the next tick rather than immediately —
 * Safari has not begun the download when `click()` returns, and revoking in
 * the same tick cancels it.
 */
export function downloadTextFile(filename: string, body: string,
                                 type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
