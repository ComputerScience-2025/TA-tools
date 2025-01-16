const defaultRosterFile = "roster.csv";
const rosterSeparator = ",";

export type Roster = {
    students: RosterEntry[];
}

type RosterEntry = {
    userName: string;
    fullName: string;
}
const rosterKeys = ["userName", "fullName"];

function parseRoster(fileContent: string): Roster {
    let lines = fileContent.split("\n").filter(line => line.trim() !== "");
    let header = lines[0].split(rosterSeparator);
    console.log("Header: ", header);
    if (header.at(-1)?.endsWith("\r")) {
        console.log("Please format your roster file with Unix line endings (LF)");
        throw new Error("Invalid line endings");
    }
    
    if (!header.every((key, index) => key === rosterKeys[index])) {
        throw new Error(`Invalid roster file header: ${header}`);
    }
    
    let students = lines.slice(1).map(line => {
        let values = line.split(rosterSeparator);
        return {
            userName: values[0],
            fullName: values[1],
        }
    });
    
    return {
        students: students,
    }
}

export async function askForRosterFile(): Promise<Roster> {
    let rosterFileName = prompt(`Enter the path to the roster file (default "${defaultRosterFile}"): `) ?? defaultRosterFile;
    let rosterFile = Bun.file(rosterFileName);
    if (!await rosterFile.exists()) {
        throw new Error(`Roster file "${rosterFileName}" does not exist`);
    }
    let rosterFileText = await rosterFile.text();
    return parseRoster(rosterFileText);
}
