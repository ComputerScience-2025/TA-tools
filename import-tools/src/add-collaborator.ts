import {askForRosterFile} from "./helper/roster.ts";
import {Config} from "./config.ts";
import {octokit} from "./service.ts";
import {Naming} from "./helper/naming.ts";


console.log("Add a collaborator to repositories based on roster");

let roster = await askForRosterFile();
console.log(roster);

let organization = Config.getGitHubOrgName();
let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let collaborator = prompt("Enter the collaborator's GitHub username: ") ?? "YOU_FORGOT_TO_ENTER_A_GITHUB_USERNAME";
let collaboratorRole = prompt("Enter the collaborator's role (pull/triage/push/maintain/admin): ") ?? "pull";
console.log(`Org: "${organization}" Course name: "${courseName}", section name: "${sectionName}", collaborator: "${collaborator}", role: "${collaboratorRole}"`);

let confirmation = prompt("Is this correct? (yes/no): ");
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

for (let student of roster.students) {
    console.log(`Student: ${student.fullName} (${student.userName})`);
    let repoName = Naming.makeRepositoryName({courseName, sectionName, personName: student.userName, personID: student.id});
    
    try {
        await octokit.rest.repos.addCollaborator({
            owner: organization,
            repo: repoName,
            username: collaborator,
            permission: collaboratorRole
        });
        console.log(`Added ${collaborator} to ${repoName}`);
    } catch (error) {
        console.error(`Failed to add ${collaborator} to ${repoName}:`, error);
    }
}
