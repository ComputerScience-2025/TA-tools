import type {OpenRouter} from "@openrouter/sdk";

import type {OutputViewer} from "../util/output-viewer.ts";

export type WorkflowDependencies = {
    seed: number,
    openRouter: OpenRouter,
    outputViewer: OutputViewer,
}
