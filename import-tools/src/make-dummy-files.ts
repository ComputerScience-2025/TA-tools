import fs from "fs";
import path from "path";

import {askForInternalRosterFile} from "./helper/roster-internal.ts";
import {CanvasHelper} from "./helper/canvas.ts";

let roster = await askForInternalRosterFile();
let dummyFilename = prompt("Enter the name for the dummy files: ") ?? "";
let outputDirectory = prompt("Enter the output directory for dummy files (default: ./dummy-files), relative path only: ") ?? "./dummy-files";
if (dummyFilename === "") {
    console.error("No filename provided. Exiting...");
    process.exit(1);
}
if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
}

let dummyFile = Bun.file(outputDirectory);
for (const student of roster.students) {
    let studentFilename = CanvasHelper.recreateSubmissionFilename({
        personName: student.fullName.replaceAll(" ", ""),
        personID: student.id,
        fileID: "0",
        actualFilename: path.basename(dummyFilename),
    });
    let studentFilePath = path.join(outputDirectory, studentFilename);
    // if (outputDirectory.startsWith("./")) {
    //     studentFilePath = "./" + studentFilePath;
    // }
    // let file = await Bun.write(studentFilePath, dummyFile);
    await fs.promises.cp(dummyFilename, studentFilePath);
    console.log(`Created dummy file for ${student.fullName} at ${studentFilePath}`);
}
console.log(`All dummy files created in directory: ${outputDirectory}`);
