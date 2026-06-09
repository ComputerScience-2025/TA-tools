// Injected at compile time by Bun.build({ define }) in scripts/build-all.ts
declare const EPF_VERSION: string;

const version = typeof EPF_VERSION !== "undefined" ? `v${EPF_VERSION}` : "dev";
console.log(`even-pf ${version}`);

