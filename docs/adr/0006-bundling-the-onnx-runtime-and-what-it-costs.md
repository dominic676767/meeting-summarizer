# Bundling the ONNX runtime, and what it costs

Local WASM Whisper (ADR-0004) needs an ONNX runtime, and it must be bundled rather than fetched: transformers.js defaults to a CDN, which Manifest V3's content security policy will not execute, and `env.useWasmCache` is off because its `blob:` loader is blocked too. So the runtime ships inside the extension, and the extension is no longer weightless in the sense "Stay weightless" originally meant.

We ship the **plain** `ort-wasm-simd-threaded` pair, not the asyncify one. Asyncify instruments the entire module so WASM execution can suspend, which is needed only for the proxy worker and the WebGPU/JSEP backends. Transcription runs single-threaded CPU WASM with `proxy = false` (extension pages are not cross-origin isolated, so `SharedArrayBuffer` and threaded mode are unavailable anyway), so nothing suspends. Same inference, 12.9 MB instead of 23.6 MB.

## What it actually costs

- **14 MB unpacked on disk**, down from 24 MB. This is what a developer loading `dist/` unpacked sees.
- **~3.4 MB packaged.** WASM compresses roughly 4×, so a store install downloads about that. The honest headline figure is 3.4 MB, not 24 MB — but the unpacked number is what a developer meets first, which is why it is recorded here.
- **A model on top, in browser cache, not in the package**: 40 MB (tiny), 75 MB (base, the default), or 250 MB (small). Fetched once on first transcription. This is the larger footprint by far and it is the user's choice of accuracy against disk.

Set against "Stay weightless", the extension's *runtime* behaviour is still light — a service worker, a content script, and an offscreen document that exists only while recording or transcribing. What is heavy is the one-time cost of putting a speech-to-text engine on the user's machine, which is the price of the privacy default in ADR-0004: the alternative is uploading meeting audio to somebody else's computer.

## Consequences

- Ship only the variant the worker actually loads. A second, unused runtime is 13–24 MB of dead weight, and both `build.mjs` and the worker's `wasmPaths` must name the same pair or the loader fetches a file that is not there.
- **This choice is not covered by the test suite.** The opt-in integration test runs `onnxruntime-node`, not the browser WASM path, so no test can catch a wrong variant — it fails at runtime in the offscreen document, and only there. Changing the variant requires a real browser check.
- Anyone reaching for WebGPU (`device: "webgpu"`) or the proxy worker must switch back to an asyncify or jsep build and accept the size, rather than assuming the plain one will suspend.

## Considered options

- **Keep asyncify** — rejected: 10.6 MB for a suspend capability this configuration never uses.
- **Fetch the runtime at first use** — rejected: MV3's CSP is what forced bundling in the first place, and a runtime fetched at first use is a runtime that fails behind a corporate proxy on the one meeting the user needed it for.
- **Cloud transcription only** — rejected outright; ADR-0004 makes the local engine the default precisely so the privacy story survives a user with no API key.
