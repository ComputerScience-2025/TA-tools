import {askForRosterFile} from "./helper/roster.ts";
import {Naming} from "./helper/naming.ts";
import {octokit, OctokitRequestError} from "./service.ts";
import {Config} from "./config.ts";


console.log("Setting up repositories for students");

let roster = await askForRosterFile();
console.log(roster);

let organization = Config.getGitHubOrgName();
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
    let repoName = Naming.makeRepositoryName({courseName, sectionName, personName: student.userName, personID: student.id});
    let repoExists = true;
    
    try {
        let resp = await octokit.request("GET /repos/{owner}/{repo}", {
            owner: organization,
            repo: repoName,
        });
        repoExists = resp.status == 200;
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
