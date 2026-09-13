// Writes the Summary Artifact via the downloads API — the only file-write
// path a pure WebExtension has (ADR-0001). Lands silently under
// Downloads/meeting-summaries/; uniquify handles same-day collisions.
export async function writeArtifact(html: string, filename: string): Promise<void> {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({
      url,
      filename: `meeting-summaries/${filename}`,
      conflictAction: "uniquify",
      saveAs: false,
    });
    await waitForCompletion(id);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Resolves only when the downloads API confirms the write completed. */
function waitForCompletion(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (delta: browser.downloads._OnChangedDownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        browser.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state?.current === "interrupted" || delta.error?.current) {
        browser.downloads.onChanged.removeListener(listener);
        reject(new Error(`download interrupted: ${delta.error?.current ?? "unknown"}`));
      }
    };
    browser.downloads.onChanged.addListener(listener);
    // In case the download completed before the listener attached:
    browser.downloads
      .search({ id: downloadId })
      .then(([d]) => {
        if (d?.state === "complete") {
          browser.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (d?.state === "interrupted") {
          browser.downloads.onChanged.removeListener(listener);
          reject(new Error(`download interrupted: ${d.error ?? "unknown"}`));
        }
      })
      .catch(() => {});
  });
}
