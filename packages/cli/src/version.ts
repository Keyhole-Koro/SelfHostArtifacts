// Replaced with package.json's version when build.mjs bundles the CLI.
declare const __ARTIFACT_VERSION__: string | undefined;

export const VERSION = typeof __ARTIFACT_VERSION__ === "string" ? __ARTIFACT_VERSION__ : "dev";
