import {askForInternalRosterFile} from "./helper/roster-internal.ts";
import {Config} from "./config.ts";
import {octokit} from "./service.ts";
import {Naming} from "./helper/naming.ts";


enum InviteeType {
    User = "user",
    Team = "team",
}


console.log("Add a collaborator to repositories based on roster");

let roster = await askForInternalRosterFile();
console.log(roster);

let organization = Config.GitHub.organizationName();
let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let collaboratorType = prompt("Enter the collaborator type (user/team): ") ?? "user";
let collaboratorName = prompt("Enter the collaborator's GitHub username: ") ?? "YOU_FORGOT_TO_ENTER_A_GITHUB_USERNAME";
let collaboratorRole = prompt("Enter the collaborator's role (pull/triage/push/maintain/admin): ") ?? "pull";
console.log(`Org: "${organization}" Course name: "${courseName}", section name: "${sectionName}", collaborator: "${collaboratorName}", role: "${collaboratorRole}"`);

let confirmation = prompt("Is this correct? (yes/no): ");
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

for (let student of roster.students) {
    console.log(`Student: ${student.fullName} (${student.userName})`);
    let repoName = Naming.makeRepositoryName({courseName, sectionName, personName: student.userName, personID: student.id});
    
    switch (collaboratorType) {
        case InviteeType.User:
            try {
                await octokit.rest.repos.addCollaborator({
                    owner: organization,
                    repo: repoName,
                    username: collaboratorName,
                    permission: collaboratorRole
                });
                console.log(`Added ${collaboratorName} to ${repoName}`);
            } catch (error) {
                console.error(`Failed to add ${collaboratorName} to ${repoName}:`, error);
            }
            break;
        case InviteeType.Team:
            try {
                await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
                    org: organization,
                    team_slug: collaboratorName,
                    owner: organization,
                    repo: repoName,
                    permission: collaboratorRole
                });
                console.log(`Added team ${collaboratorName} to ${repoName}`);
            } catch (e) {
                console.error(`Failed to add team ${collaboratorName} to ${repoName}:`, e);
            }
            break;
        default:
            console.error(`Invalid collaborator type "${collaboratorType}"`);
            break;
    }
    
}
