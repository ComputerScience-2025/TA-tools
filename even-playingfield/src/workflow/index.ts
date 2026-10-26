import type {OutputViewer} from "../util/output-viewer.ts";
import type {Config} from "../util/config-loader.ts";
import type {LlmClient} from "../util/llm.ts";
import type {EnvProvider, Logger, ShellRunner, VirtualFileSystem} from "../platform/types.ts";

/**
 * The slice of {@link LlmClient} the workflows call. Typed structurally so a
 * test (or a future provider host) can supply its own implementation.
 */
export type CompletionClient = Pick<LlmClient, "generateCompletion">;

export type WorkflowDependencies = {
    outputViewer: OutputViewer,
    config: Config,
    llmClient: CompletionClient,
    fs: VirtualFileSystem,
    env: EnvProvider,
    shell: ShellRunner,
    logger: Logger,
}
