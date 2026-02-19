import { appendFile } from "node:fs/promises";

import {ARGS} from "./args.ts";

export async function recordCompletionInput(inputs: {role: string, content: any}[]) {
    let completionInputsDestination = ARGS.values.completion_inputs_destination;
    if (!completionInputsDestination) {
        return;
    }
    
    if (!(await Bun.file(completionInputsDestination).exists())){
        console.warn(`Completion inputs destination file ${completionInputsDestination} does not exist`);
        return;
    }
    
    await appendFile(completionInputsDestination, JSON.stringify(completionInputsDestination)+"\n");
    console.log(`Recorded completion inputs to ${completionInputsDestination}`);
}
