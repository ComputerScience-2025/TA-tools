import { parseArgs } from "util";

// console.log(Bun.argv);
export const ARGS = parseArgs({
    args: Bun.argv,
    options: {
        // mode: {
        //     type: "string",
        //     short: "M",
        //     default: "run",
        // },
        config: {
            type: "string",
            short: "C",
        },
        dir: {
            type: "string",
            short: "D",
            default: ".",
        },
        skip_workflow: {
            type: "string",
            short: "S",
            multiple: true,
        },
        only_workflows: {
            type: "string",
            short: "O",
            multiple: true,
        },
        completion_inputs_destination: {
            type: "string",
        },
    },
    strict: true,
    allowPositionals: true,
});

// export enum RunMode {
//     Run = "run",
//     Eval = "eval",
// }
