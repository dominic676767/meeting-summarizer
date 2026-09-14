// The WebExtension API namespace, resolved in exactly one place. We target
// Chromium (ADR-0003, Firefox retired), where the canonical global is `chrome`
// and its MV3 APIs return Promises directly. Every other module imports `ext`
// instead of touching a global, so the namespace assumption lives here alone.
//
// Resolved off globalThis rather than referencing `chrome` directly: modules
// that merely import this file must be loadable under the test runner, where
// no extension globals exist. Anything that actually calls into `ext` outside
// a browser is expected to install its own fake.
export const ext: typeof chrome = (globalThis as { chrome?: typeof chrome }).chrome as typeof chrome;
