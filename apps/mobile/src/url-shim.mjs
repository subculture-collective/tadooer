// `apps/desktop/src/policy.mjs` imports `URL` from `node:url`. A WebView has
// the same class as a global; the browser bundles alias the import to this.
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
