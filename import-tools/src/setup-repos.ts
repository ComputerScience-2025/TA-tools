import {askForRosterFile} from "./helper/roster.ts";
import {Naming} from "./helper/naming.ts";
import {octokit, OctokitRequestError} from "./service.ts";


console.log("Setting up repositories for students");

let roster = await askForRosterFile();
console.log(roster);

let organization = process.env.IMPTTOOLS_GH_ORG ?? "";
let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
console.log(`Org: "${organization}" Course name: "${courseName}", section name: "${sectionName}"`);
let confirmation = prompt("Is this correct? (yes/no): ");
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

for (let student of roster.students){
    console.log(`Student: ${student.fullName} (${student.userName})`);
    let repoName = Naming.makeRepositoryName({courseName, sectionName, personName: student.userName});
    let repoExists = true;
    
    try {
        let resp = await octokit.request("GET /repos/{owner}/{repo}", {
            owner: organization,
            repo: repoName,
        });
        if (resp.status == 200) {
            repoExists = true;
        }
        else {
            repoExists = false;
        }
    } catch (e) {
        if (e instanceof OctokitRequestError){
            if (e.status == 404) {
                repoExists = false;
            }
        } else {
            console.error("Unknown error when checking for repository");
            console.log(e);
        }
    }
    
    if (repoExists) {
        console.log(`Repository "${repoName}" already exists`);
        continue;
    }
    
    console.log(`Repository "${repoName}" does not exist, creating...`);
    try {
        let resp = await octokit.request("POST /orgs/{org}/repos", {
            org: organization,
            name: repoName,
            private: true,
        });
        if (resp.status == 201) {
            console.log(`Repository "${repoName}" created`);
        }
        else {
            console.error(`Error creating repository, status: ${resp.status}`);
            console.log(resp);
        }
    } catch (e) {
        console.error("Error creating repository");
        console.log(e);
    }
}
