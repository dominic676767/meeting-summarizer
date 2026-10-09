// Paste this file into the Zoom tab's DevTools Console.
// Start in the "top" context. See README.md in this directory.
(() => {
  const captureId = crypto.randomUUID();
  const nodeIds = new WeakMap();
  let nextNodeId = 1;

  const nodeId = (node) => {
    if (!nodeIds.has(node)) nodeIds.set(node, nextNodeId++);
    return nodeIds.get(node);
  };

  const readDocument = (target) => {
    const doc = target.document;
    return {
      capturedAt: new Date().toISOString(),
      url: target.location.href,
      documentId: nodeId(doc),
      captionRoots: Array.from(
        doc.querySelectorAll(".live-transcription-subtitle__box"),
        nodeId,
      ),
      transcriptRoots: Array.from(
        doc.querySelectorAll(".new-lt-list-container"),
        nodeId,
      ),
      html: doc.documentElement.outerHTML,
    };
  };

  window.zoomDump = (label) => {
    if (typeof label !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) {
      throw new Error("Use a label such as zoom-panel-bottom.");
    }

    const context = window === window.top ? "top" : "frame";
    const capturedAt = new Date().toISOString();
    const bundle = { captureId, context, capturedAt };

    if (context === "top") {
      bundle.top = readDocument(window);
      const frame = document.querySelector("iframe#webclient");
      if (!frame) {
        bundle.webclient = { status: "not-present" };
      } else {
        bundle.webclient = {
          status: "unreadable",
          elementId: nodeId(frame),
          srcAttribute: frame.getAttribute("src"),
        };
        try {
          const contents = readDocument(frame.contentWindow);
          bundle.webclient = {
            ...bundle.webclient,
            status: "captured",
            ...contents,
          };
        } catch (error) {
          bundle.webclient.error = error.name;
        }
      }
    } else {
      bundle.frame = readDocument(window);
    }

    const fileName = `${label}.${context}.${capturedAt.replace(/[:.]/g, "-")}.json`;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    (document.body || document.documentElement).append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const frameStatus = bundle.webclient?.status ?? "selected-frame";
    console.info("Check Downloads for", fileName, "Frame status:", frameStatus);
    return { fileName, frameStatus, captureId };
  };

  console.info('Capture helper ready. Example: zoomDump("zoom-panel-bottom")');
})();
