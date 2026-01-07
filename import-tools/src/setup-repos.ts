import {askForInternalRosterFile, RosterCreator} from "./helper/roster-internal.ts";
import {Naming} from "./helper/naming.ts";
import {octokit, OctokitRequestError} from "./helper/service.ts";
import {Config} from "./helper/config.ts";

console.log("Setting up repositories for students");

let roster = await askForInternalRosterFile();
console.log(roster);

let organization = Config.GitHub.organizationName();
let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
console.log(`Org: "${organization}" Course name: "${courseName}", section name: "${sectionName}"`);
let confirmation = prompt("Is this correct? (yes/no): ");
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

// Create a RosterCreator instance to save updates
let rosterCreator = new RosterCreator("roster_updated.json", sectionName);

for (let student of roster.students) {
    console.log(`Student: ${student.fullName} (${student.userName})`);
    let repoName = Naming.makeRepositoryName({courseName, sectionName, personName: student.userName, personID: student.id});
    let repoExists = true;

    try {
        let resp = await octokit.request("GET /repos/{owner}/{repo}", {
            owner: organization,
            repo: repoName,
        });
        repoExists = resp.status == 200;
    } catch (e) {
        if (e instanceof OctokitRequestError) {
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
        let createRepoResp = await octokit.request("POST /orgs/{org}/repos", {
            org: organization,
            name: repoName,
            private: true,
        });
        if (createRepoResp.status == 201) {
            console.log(`Repository "${repoName}" created`);

            // Initialize the repository with a README.md file
            console.log("Initializing repository...");
            let repoInitializationResp = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
                owner: organization,
                repo: repoName,
                path: "README.md",
                message: "Initial commit",
                content: Buffer.from(`# ${repoName}\n\nRepository for ${student.fullName}'s submissions`).toString('base64'),
            });

            if (repoInitializationResp.status == 201) {
                console.log(`Initialized repository "${repoName}" with README.md`);
            } else {
                console.error(`Error initializing repository, status: ${repoInitializationResp.status}`);
                console.log(repoInitializationResp);
            }

            // Save the repository URL to the student's data
            student.repoURL = `https://github.com/${organization}/${repoName}`;
        } else {
            console.error(`Error creating repository, status: ${createRepoResp.status}`);
            console.log(createRepoResp);
        }
    } catch (e) {
        console.error("Error creating repository");
        console.log(e);
    }
    
    console.log("Adding student to the repository");
    console.assert(student.email.includes("@"), "Student email should be a valid email");
    let inviteeUsername = student.email;
    try {
        await octokit.rest.repos.addCollaborator({
            owner:  organization,
            repo: repoName,
            username: inviteeUsername,
            permission: "pull", // Read access
        });
        console.log(`Added ${inviteeUsername} to ${repoName}`);
    } catch (error) {
        console.error(`Failed to add ${inviteeUsername} to ${repoName}:`, error);
        if (error instanceof OctokitRequestError && error.status === 404) {
            console.error(`User ${inviteeUsername} not found on GitHub.`);
        }
    }

    // Add the updated student to the roster
    rosterCreator.addStudent(student);
}

// Save the updated roster
await rosterCreator.save();
console.log("Updated roster saved to 'roster_updated.json'");
