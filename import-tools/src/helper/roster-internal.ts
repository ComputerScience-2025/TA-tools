const defaultRosterFile = "roster.json";

export type ConvertedRoster = {
    students: RosterStudentEntry[];
}

export type RosterStudentEntry = {
    id: string;
    email: string;
    userName: string;
    fullName: string;
    section: string;
    repoURL?: string;
    githubUsername?: string;
}

function parseRoster(fileContent: string): ConvertedRoster {
    return JSON.parse(fileContent); // TODO: validate the JSON
}

export async function askForInternalRosterFile(): Promise<ConvertedRoster> {
    let rosterFileName = prompt(`Enter the path to the roster file (default "${defaultRosterFile}"): `) ?? defaultRosterFile;
    let rosterFile = Bun.file(rosterFileName);
    if (!await rosterFile.exists()) {
        throw new Error(`Roster file "${rosterFileName}" does not exist`);
    }
    let rosterFileText = await rosterFile.text();
    return parseRoster(rosterFileText);
}

export function convertRosterToCSV(roster: ConvertedRoster): string {
    if (!roster.students.length) {
        return "id,email,userName,fullName,section,repoURL,githubUsername\n"; // Header only
    }
    
    const header = Object.keys(roster.students[0]).join(",");
    const rows = roster.students.map(student =>
        Object.values(student).map(value => `"${value ?? ""}"`).join(",")
    );
    
    return [header, ...rows].join("\n");
}

export class RosterCreator {
    private readonly roster: ConvertedRoster;
    readonly filename: string;
    private readonly section: string;

    constructor(filename: string, section: string) {
        this.filename = filename;
        this.roster = { students: [] };
        this.section = section;
    }

    addStudent(student: Omit<RosterStudentEntry, "section">) {
        this.roster.students.push({...student, section: this.section});
    }

    async save() {
        let file = Bun.file(this.filename);
        await file.write(JSON.stringify(this.roster));
    }
}
