import { readConfig } from "../util/config.ts";
import type { Config } from "../util/config.ts";
import { Engine } from "../engine/index.ts";
import type { WorkflowRunResult } from "../engine/index.ts";
import { startApiServer } from "../api-server.ts";
import { OutputViewingModeEnum } from "../util/config-schema.ts";


/**
 * Options accepted by the embeddable EPF core. Mirrors the CLI flags of
 * cli-host.ts so that both hosts share the same input surface.
 */
export type EPFOptions = {
    config?: string;
    dir?: string;
    only_workflows?: string[];
    skip_workflow?: string[];
};

type ApiServerHandle = { url: string; stop: () => void };

/**
 * Runtime-agnostic, embeddable core that owns the Engine and (optionally)
 * the local API server. Has no dependency on process.stdin/stdout REPL,
 * Bun.argv, or CLI argument parsing — it can be embedded inside another
 * program without spawning a subprocess.
 *
 * Construct via the async factory {@link EPF.create}.
 */
export class EPF {
    readonly engine: Engine;
    readonly config: Config;
    private readonly options: EPFOptions;
    private apiServerHandle: ApiServerHandle | null;
    private frontendURL: string;

    private constructor(options: EPFOptions, config: Config, resolvedConfigPath?: string) {
        this.options = options;
        this.config = config;
        this.engine = new Engine(config, resolvedConfigPath);
        this.apiServerHandle = null;
        this.frontendURL = "";
    }

    /**
     * Async factory: loads config (honoring `options.config`), builds the
     * Engine, and starts the API server when the config requests WebUI
     * output-viewing mode.
     */
    static async create(options: EPFOptions): Promise<EPF> {
        // Change working directory before config resolution so that a relative
        // --config path and workflow file globs resolve against `dir`.
        if (options.dir && options.dir.length > 0 && options.dir !== ".") {
            process.chdir(options.dir);
        }

        const resolved = await readConfig(options.config);
        const config = resolved.config;

        const epf = new EPF(options, config, resolved.path);

        if (config.output_viewing.mode === OutputViewingModeEnum.WebUI) {
            epf.apiServerHandle = startApiServer(epf.engine, config.output_viewing.api_port);
            const params = new URLSearchParams();
            params.set("api", epf.apiServerHandle.url);
            epf.frontendURL = `${config.output_viewing.webui_base_url}/tools/results-viewer#${params.toString()}`;
        }

        return epf;
    }

    /**
     * Run the initial workflow batch using the `only_workflows` / `skip_workflow`
     * options supplied at construction time.
     */
    async runInitial(): Promise<WorkflowRunResult[]> {
        return await this.engine.runWorkflows({
            only: this.options.only_workflows,
            skip: this.options.skip_workflow,
        });
    }

    /** URL of the API server, or null when not running in WebUI mode. */
    getApiUrl(): string | null {
        return this.apiServerHandle ? this.apiServerHandle.url : null;
    }

    /** Frontend (dashboard) URL for viewing outputs in WebUI mode. */
    getFrontendUrl(): string {
        return this.frontendURL;
    }

    /** Stop the API server if one is running. */
    stop(): void {
        if (this.apiServerHandle) {
            this.apiServerHandle.stop();
            this.apiServerHandle = null;
        }
    }
}
