import {Glob} from "bun";

import {CanvasHelper} from "./helper/canvas.ts";
import {octokit, OctokitRequestError} from "./service.ts";
import {EnvConfig} from "./config.ts";
import {Naming} from "./helper/naming.ts";


const inputDirectory = "./submissions";


function fixFileName(originalName: string) {
    // turn the filename from "ABC-1.cs" to "ABC.cs"
    return originalName;
}

console.log("Uploading files to repositories...");
console.log(`Input directory: ${inputDirectory}`);
let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let assignmentName = prompt("Enter the assignment name: ") ?? "YOU_FORGOT_TO_ENTER_AN_ASSIGNMENT_NAME";
let repoPrefix = Naming.repositoryNamePrefix({courseName, sectionName});
console.log(`Course: ${courseName}, Section: ${sectionName}, Assignment: ${assignmentName}, Repo Prefix: ${repoPrefix}`);

let files = new Map<string, {fullFN: string, actualFN: string}[]>();

for await (const filepath of new Glob(`${inputDirectory}/*`).scan(".")) {
    let separator = filepath.indexOf("/") > -1 ? "/" : "\\"; // Windows uses backslash, Unix uses forward slash
    let filename = filepath.split(separator).pop();
    console.log(filename); // => "index.ts"
    if (!filename) {
        console.error("Error parsing filename");
        continue;
    }
    
    let parsed = CanvasHelper.parseSubmissionFilename(filename);
    console.log(parsed);
    if (!files.has(parsed.personID)) {
        files.set(parsed.personID, []);
    }
    files.get(parsed.personID)?.push({fullFN: filepath, actualFN: fixFileName(parsed.actualFilename)});
}

console.log(files);

console.log("Getting repositories...");
let repos = await octokit.request("GET /orgs/{org}/repos", {
    org: EnvConfig.getGitHubOrgName(),
    per_page: 100, // TODO: pagination
});
let repoMap = new Map<string, string>();
for (let repo of repos.data) {
    if (repo.name.startsWith(repoPrefix)) {
        let repoNameParsed = Naming.parseRepositoryName(repo.name);
        repoMap.set(repoNameParsed.personID, repo.name);
    }
}

for (let [studentID, fileArray] of files) {
    console.log(`Student ID: ${studentID}`);
    let repoName = repoMap.get(studentID);
    if (!repoName) {
        console.error(`Repository not found for student ID: ${studentID}`);
        continue;
    }
    
    const baseBranch = "main";
    const newBranch = assignmentName;  // TODO: make sure the assignment name is valid
    
    // Thanks to GitHub Copilot
    
    // Step 1: Get the latest commit SHA of the base branch
    console.log(`Getting latest commit SHA for base branch: ${baseBranch}`);
    const { data: refData } = await octokit.rest.git.getRef({
        owner: EnvConfig.getGitHubOrgName(),
        repo: repoName,
        ref: `heads/${baseBranch}`,
    });
    const latestCommitSha = refData.object.sha;
    
    // Step 2: Create a new branch
    console.log(`Creating branch: ${newBranch}`);
    await octokit.rest.git.createRef({
        owner: EnvConfig.getGitHubOrgName(),
        repo: repoName,
        ref: `refs/heads/${newBranch}`,
        sha: latestCommitSha,
    });
    
    // Step 4: Create blobs for each file
    console.log("Creating blobs...");
    const blobs = await Promise.all(fileArray.map(async (fileToAdd) => {
        const { data: blobData } = await octokit.rest.git.createBlob({
            owner: EnvConfig.getGitHubOrgName(),
            repo: repoName,
            content: Buffer.from(await Bun.file(fileToAdd.fullFN).text()).toString("base64"),
            encoding: "base64",
        });
        return { path: `${assignmentName}/${fileToAdd.actualFN}`, sha: blobData.sha };
    }));
    
    // Step 5: Create a new tree with the blobs
    console.log("Creating tree...");
    const { data: treeData } = await octokit.rest.git.createTree({
        owner: EnvConfig.getGitHubOrgName(),
        repo: repoName,
        tree: blobs.map(blob => ({
            path: blob.path,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
        })),
    });
    
    // Step 6: Create a new commit
    console.log("Creating commit...");
    const { data: newCommitData } = await octokit.rest.git.createCommit({
        owner: EnvConfig.getGitHubOrgName(),
        repo: repoName,
        message: `Adding files for ${newBranch}`,
        tree: treeData.sha,
        parents: [latestCommitSha],
    });
    
    // Step 7: Update the new branch to point to the new commit
    console.log("Updating branch...");
    await octokit.rest.git.updateRef({
        owner: EnvConfig.getGitHubOrgName(),
        repo: repoName,
        ref: `heads/${newBranch}`,
        sha: newCommitData.sha,
    });
    
    console.log("Branch created and files added successfully!");
    
    // Create a pull request
    console.log("Creating pull request...");
    const { data: pullRequest } = await octokit.rest.pulls.create({
        owner: EnvConfig.getGitHubOrgName(),
        repo: repoName,
        title: `Assignment: ${assignmentName}`,
        head: newBranch,
        base: baseBranch,
        body: `Auto generated pull request for assignment: ${assignmentName}`,
    });
    
    console.log(`Pull request created: ${pullRequest.html_url}`);
    console.log(`Finished processing student ID: ${studentID}`);
}

