/**
 * The EPF app is entirely client-side: browser storage, the engine and every
 * panel need `window`/IndexedDB. Page options in a layout apply to all child
 * routes, so this covers Source, Config, Console and Outputs.
 */
export const ssr = false;
