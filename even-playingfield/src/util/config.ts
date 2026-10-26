/**
 * Config entry point kept for host code and for `epf-eval`, which import this
 * module path. The implementation lives in `config-loader.ts` and is driven by
 * the platform, so this module stays free of Bun/Node imports.
 *
 * CLI hosts call `loadConfig(createBunPlatform(), path)` directly.
 */

export {
    CONFIG_URL_ENV_VAR,
    DEFAULT_CONFIG_FILE_NAME,
    configSourceLabel,
    formatConfigIssues,
    loadConfig,
    loadRawConfig,
    resolveConfigSource,
    toConfigSource,
    validateConfigObject,
    validateConfigText,
} from "./config-loader.ts";
export type { Config, ConfigSource, ResolvedConfig } from "./config-loader.ts";
