import parse from "csv-simple-parser";

import {RosterCreator} from "./helper/roster-internal";
import {extractNameFromParts, extractUserNameFromEmail} from "./helper/extract";

const defaultRosterFile = "canvas.csv";


async function convertCanvasGradebookToRoster(sourceFilename: string, section: string) {
    let file = Bun.file(sourceFilename);
    if (!await file.exists()) {
        throw new Error(`Roster file "${sourceFilename}" does not exist`);
    }
    
    const csv = parse((await file.text()).trim(), { header: true });
    
    csv.shift(); // remove the header
    csv.shift(); // remove the secondary header
    
    console.log(csv);
    
    let rosterCreator = new RosterCreator(`${sourceFilename}.json`, section);
    for (const row of csv) {
        if (!("SIS Login ID" in row) || !("Student" in row) || !("ID" in row)) {
               console.error(`Invalid row: ${JSON.stringify(row)}`);
               continue;
        }
        
        let data: Parameters<RosterCreator["addStudent"]>[0] = {
            id: row["ID"] as string,
            email: row["SIS Login ID"] as string,
            userName: extractUserNameFromEmail(row["SIS Login ID"] as string),
            fullName: extractNameFromParts(row["Student"] as string),
        };
        
        if ("githubUsername" in row) {
            data.githubUsername = row["githubUsername"] as string;
        }
        
        rosterCreator.addStudent(data)
    }
    await rosterCreator.save();
}

async function main() {
    console.log("process.argv[1]", process.argv[1]);
    console.log("import.meta.url", import.meta.url);
    
    if (!import.meta.url.includes(process.argv[1].replaceAll("\\", "/"))) {
        console.error("This script must be run directly, not imported");
        return;
    }
    
    let rosterFileName = prompt(`Enter the path to the roster file (default "${defaultRosterFile}"): `) ?? defaultRosterFile;
    let section = prompt("Enter the section name: ") ?? "default";
    
    convertCanvasGradebookToRoster(rosterFileName, section);
}

main().then(r => void 0);
