import {Glob} from "bun";
import {CanvasHelper} from "./helper/canvas.ts";
import {Config} from "./config.ts";


for await (const filepath of new Glob(`${Config.submissionInputDirectory}/*`).scan(".")) {
    let separator = filepath.indexOf("/") > -1 ? "/" : "\\"; // Windows uses backslash, Unix uses forward slash
    let filename = filepath.split(separator).pop();
    // console.log(filename); // => "index.ts"
    if (!filename) {
        console.error("Error parsing filename");
        continue;
    }
    
    let parsed = CanvasHelper.parseSubmissionFilename(filename);
    // console.log(parsed);
    
    console.log(`${filepath} -> ${CanvasHelper.fixFileName(parsed.actualFilename)}`);
}
