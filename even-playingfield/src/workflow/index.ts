import type {OutputViewer} from "../util/output-viewer.ts";
import type {Config} from "../util/config.ts";
import type {LlmClient} from "../util/llm.ts";

export type WorkflowDependencies = {
    outputViewer: OutputViewer,
    config: Config,
    llmClient: LlmClient,
}
