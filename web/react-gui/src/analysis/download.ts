/** Download raw string content, such as CSV, as a file. */
export function downloadBlob(fileName: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Download an already-encoded data: URL, such as an ECharts PNG export.
 * The browser decodes the data URL natively; do not wrap it in a Blob.
 */
export function downloadDataUrl(fileName: string, dataUrl: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
