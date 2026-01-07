import {Glob} from "bun";

import {CanvasHelper} from "./helper/canvas.ts";
import {octokit} from "./helper/service.ts";
import {Config} from "./helper/config.ts";
import {Naming} from "./helper/naming.ts";


console.log("Uploading files to repositories...");
console.log(`Input directory: ${Config.submissionInputDirectory}`);
let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let assignmentName = prompt("Enter the assignment name: ") ?? "YOU_FORGOT_TO_ENTER_AN_ASSIGNMENT_NAME";
let repoPrefix = Naming.repositoryNamePrefix({courseName, sectionName});
console.log(`Course: ${courseName}, Section: ${sectionName}, Assignment: ${assignmentName}, Repo Prefix: ${repoPrefix}`);

let files = new Map<string, {fullFN: string, actualFN: string}[]>();

for await (const filepath of new Glob(`${Config.submissionInputDirectory}/*`).scan(".")) {
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
    files.get(parsed.personID)?.push({fullFN: filepath, actualFN: CanvasHelper.fixFileName(parsed.actualFilename)});
}

console.log(files);

console.log("Getting repositories...");
let repos = await octokit.request("GET /orgs/{org}/repos", {
    org: Config.GitHub.organizationName(),
    per_page: 100, // TODO: pagination
});
let repoMap = new Map<string, string>();
for (let repo of repos.data) {
    if (repo.name.startsWith(repoPrefix)) {
        let repoNameParsed = Naming.parseRepositoryName(repo.name);
        repoMap.set(repoNameParsed.personID, repo.name);
    }
}

let processedCount = 0;
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
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        ref: `heads/${baseBranch}`,
    });
    const latestCommitSha = refData.object.sha;
    
    // Step 2: Check if branch already exists and delete it
    console.log(`Checking if branch ${newBranch} already exists...`);
    try {
        await octokit.rest.git.getRef({
            owner: Config.GitHub.organizationName(),
            repo: repoName,
            ref: `heads/${newBranch}`,
        });
        // Branch exists, delete it
        console.log(`Branch ${newBranch} already exists. Deleting...`);
        await octokit.rest.git.deleteRef({
            owner: Config.GitHub.organizationName(),
            repo: repoName,
            ref: `heads/${newBranch}`,
        });
        console.log(`Branch ${newBranch} deleted successfully.`);
    } catch (error) {
        // Branch doesn't exist, which is fine
        if (error instanceof Error && 'status' in error && error.status === 404) {
            console.log(`Branch ${newBranch} does not exist. Proceeding to create it.`);
        } else {
            throw error;
        }
    }
    
    // Step 3: Create a new branch
    console.log(`Creating branch: ${newBranch}`);
    await octokit.rest.git.createRef({
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        ref: `refs/heads/${newBranch}`,
        sha: latestCommitSha,
    });
    
    // Step 4: Get the base tree from the latest commit
    console.log("Getting base tree...");
    const { data: baseCommitData } = await octokit.rest.git.getCommit({
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        commit_sha: latestCommitSha,
    });
    const baseTreeSha = baseCommitData.tree.sha;
    
    // Step 5: Create blobs for each file
    console.log("Creating blobs...");
    const blobs = await Promise.all(fileArray.map(async (fileToAdd) => {
        const { data: blobData } = await octokit.rest.git.createBlob({
            owner: Config.GitHub.organizationName(),
            repo: repoName,
            content: Buffer.from(await Bun.file(fileToAdd.fullFN).text()).toString("base64"),
            encoding: "base64",
        });
        return { path: `${assignmentName}/${fileToAdd.actualFN}`, sha: blobData.sha };
    }));
    
    // Step 6: Create a new tree with the blobs, based on the existing tree
    console.log("Creating tree...");
    const { data: treeData } = await octokit.rest.git.createTree({
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        base_tree: baseTreeSha,  // This preserves existing files
        tree: blobs.map(blob => ({
            path: blob.path,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
        })),
    });
    
    // Step 7: Create a new commit
    console.log("Creating commit...");
    const { data: newCommitData } = await octokit.rest.git.createCommit({
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        message: `Adding files for ${newBranch}`,
        tree: treeData.sha,
        parents: [latestCommitSha],
    });
    
    // Step 8: Update the new branch to point to the new commit
    console.log("Updating branch...");
    await octokit.rest.git.updateRef({
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        ref: `heads/${newBranch}`,
        sha: newCommitData.sha,
    });
    
    console.log("Branch created and files added successfully!");
    
    // Create a pull request
    console.log("Creating pull request...");
    const { data: pullRequest } = await octokit.rest.pulls.create({
        owner: Config.GitHub.organizationName(),
        repo: repoName,
        title: `Assignment: ${assignmentName}`,
        head: newBranch,
        base: baseBranch,
        body: `Auto generated pull request for assignment: ${assignmentName}`,
    });
    
    console.log(`Pull request created: ${pullRequest.html_url}`);
    console.log(`Finished processing student ID: ${studentID}`);
    processedCount++;
}

console.log(`Processed ${processedCount} students`);
