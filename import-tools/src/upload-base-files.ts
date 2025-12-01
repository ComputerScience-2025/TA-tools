import {Glob} from "bun";

import {askForInternalRosterFile} from "./helper/roster-internal.ts";
import {Naming} from "./helper/naming.ts";
import {octokit} from "./service.ts";
import {Config} from "./config.ts";


console.log("Uploading base files to repositories...");
console.log(`Base files directory: ${Config.repoBaseFilesDirectory}`);

let roster = await askForInternalRosterFile();
console.log(`Loaded roster with ${roster.students.length} students`);

let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let repoPrefix = Naming.repositoryNamePrefix({courseName, sectionName});
console.log(`Course: ${courseName}, Section: ${sectionName}, Repo Prefix: ${repoPrefix}`);

let confirmation = prompt("This will upload base files to all student repositories. Continue? (yes/no): ");
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

// Collect all files from the base files directory
console.log("Scanning base files directory...");
let baseFiles: {relativePath: string, fullPath: string}[] = [];

for await (const filepath of new Glob(`${Config.repoBaseFilesDirectory}/**/*`).scan({cwd: ".", dot: true, onlyFiles: true})) {
    console.log(`Glob found file: ${filepath}`);
    const file = Bun.file(filepath);
    if (await file.exists()) {
        // Remove the base directory prefix to get relative path
        const relativePath = filepath.replaceAll("\\", "/").replace(`${Config.repoBaseFilesDirectory}/`, "");
        if (relativePath === "") {
            throw new Error(`Relative path is empty for file: ${filepath}`);
        }
        if (relativePath === filepath){
            throw new Error(`Failed to compute relative path for file: ${filepath}`);
        }
        baseFiles.push({
            relativePath: relativePath,
            fullPath: filepath
        });
    }
}

if (baseFiles.length === 0) {
    console.log("No files found in base files directory. Exiting...");
    process.exit(0);
}

console.log(`Found ${baseFiles.length} files to upload:`);
baseFiles.forEach(f => console.log(`  - ${f.relativePath}`));

// Confirm before proceeding
confirmation = prompt(`About to upload ${baseFiles.length} files to ${roster.students.length} repositories. This action cannot be undone. Proceed? (yes/no): `);
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

// Get repositories for the students
console.log("\nGetting repositories...");
let repos = await octokit.request("GET /orgs/{org}/repos", {
    org: Config.getGitHubOrgName(),
    per_page: 100, // TODO: pagination
});

let repoMap = new Map<string, string>();
for (let repo of repos.data) {
    if (repo.name.startsWith(repoPrefix)) {
        let repoNameParsed = Naming.parseRepositoryName(repo.name);
        repoMap.set(repoNameParsed.personID, repo.name);
    }
}

console.log(`Found ${repoMap.size} matching repositories`);

// Process each student
let processedCount = 0;
let errorCount = 0;

for (let student of roster.students) {
    console.log(`\n--- Processing: ${student.fullName} (${student.userName}) ---`);
    
    let repoName = repoMap.get(student.id);
    if (!repoName) {
        console.error(`Repository not found for student ID: ${student.id}`);
        errorCount++;
        continue;
    }
    
    const baseBranch = "main";
    
    try {
        // Step 1: Get the latest commit SHA of the base branch
        console.log(`Getting latest commit SHA for branch: ${baseBranch}`);
        const { data: refData } = await octokit.rest.git.getRef({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            ref: `heads/${baseBranch}`,
        });
        const latestCommitSha = refData.object.sha;
        
        // Step 2: Get the base tree from the latest commit
        console.log("Getting base tree...");
        const { data: baseCommitData } = await octokit.rest.git.getCommit({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            commit_sha: latestCommitSha,
        });
        const baseTreeSha = baseCommitData.tree.sha;
        
        // Step 3: Create blobs for each file
        console.log(`Creating blobs for ${baseFiles.length} files...`);
        const blobs = await Promise.all(baseFiles.map(async (fileToAdd) => {
            const fileContent = await Bun.file(fileToAdd.fullPath).text();
            const { data: blobData } = await octokit.rest.git.createBlob({
                owner: Config.getGitHubOrgName(),
                repo: repoName,
                content: Buffer.from(fileContent).toString("base64"),
                encoding: "base64",
            });
            // Normalize path separators to forward slashes for GitHub
            const normalizedPath = fileToAdd.relativePath.replace(/\\/g, '/');
            return { path: normalizedPath, sha: blobData.sha };
        }));
        
        // Step 4: Create a new tree with the blobs, based on the existing tree
        console.log("Creating tree...");
        const { data: treeData } = await octokit.rest.git.createTree({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            base_tree: baseTreeSha,  // This preserves existing files
            tree: blobs.map(blob => ({
                path: blob.path,
                mode: "100644",
                type: "blob",
                sha: blob.sha,
            })),
        });
        
        // Step 5: Create a new commit
        console.log("Creating commit...");
        const { data: newCommitData } = await octokit.rest.git.createCommit({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            message: `Update base files`,
            tree: treeData.sha,
            parents: [latestCommitSha],
        });
        
        // Step 6: Update the branch to point to the new commit
        console.log("Updating branch...");
        await octokit.rest.git.updateRef({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            ref: `heads/${baseBranch}`,
            sha: newCommitData.sha,
        });
        
        console.log(`✓ Successfully uploaded base files to ${repoName}`);
        processedCount++;
    } catch (e) {
        console.error(`✗ Error processing repository ${repoName}:`);
        console.error(e);
        errorCount++;
    }
}

console.log("\n=== Summary ===");
console.log(`Total students: ${roster.students.length}`);
console.log(`Successfully processed: ${processedCount}`);
console.log(`Errors: ${errorCount}`);
console.log(`Files uploaded per repository: ${baseFiles.length}`);

