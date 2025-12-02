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
    
    console.log(`Repository: ${repoName}`);
    console.log(`Organization: ${Config.getGitHubOrgName()}`);
    
    const baseBranch = "main";
    
    try {
        // Step 1: Get the latest commit SHA of the base branch
        console.log(`Getting latest commit SHA for branch: ${baseBranch}`);
        const { data: refData } = await octokit.rest.git.getRef({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            ref: `heads/${baseBranch}`,
        });
        console.log("Ref data:", JSON.stringify(refData, null, 2));
        const latestCommitSha = refData.object.sha;
        console.log(`Latest commit SHA: ${latestCommitSha}`);
        
        // Step 2: Get the base tree from the latest commit
        console.log("Getting base tree...");
        const { data: baseCommitData } = await octokit.rest.git.getCommit({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            commit_sha: latestCommitSha,
        });
        const baseTreeSha = baseCommitData.tree.sha;
        console.log(`Base tree SHA: ${baseTreeSha}`);
        
        if (!baseTreeSha) {
            console.error("Failed to get base tree SHA");
            errorCount++;
            continue;
        }
        
        // Step 3: Create blobs for each file
        console.log(`Creating blobs for ${baseFiles.length} files...`);
        const blobs = await Promise.all(baseFiles.map(async (fileToAdd) => {
            try {
                const fileContent = await Bun.file(fileToAdd.fullPath).text();
                console.log(`  Creating blob for: ${fileToAdd.relativePath}`);
                const { data: blobData } = await octokit.rest.git.createBlob({
                    owner: Config.getGitHubOrgName(),
                    repo: repoName,
                    content: Buffer.from(fileContent).toString("base64"),
                    encoding: "base64",
                });
                console.log(`  Blob created with SHA: ${blobData.sha}`);
                // Normalize path separators to forward slashes for GitHub
                const normalizedPath = fileToAdd.relativePath.replace(/\\/g, '/');
                return { path: normalizedPath, sha: blobData.sha };
            } catch (error) {
                console.error(`  Failed to create blob for ${fileToAdd.relativePath}:`, error);
                throw error;
            }
        }));
        
        console.log(`All blobs created. Base tree SHA: ${baseTreeSha}`);
        console.log(`Blob details:`, blobs);
        
        // Validate blobs
        if (blobs.length === 0) {
            console.log("No blobs to upload, skipping...");
            continue;
        }
        
        // Check if any blob creation failed
        const invalidBlobs = blobs.filter(b => !b.sha);
        if (invalidBlobs.length > 0) {
            console.error(`Failed to create ${invalidBlobs.length} blobs`);
            errorCount++;
            continue;
        }
        
        // Step 4: Create a new tree with the blobs, based on the existing tree
        console.log("Creating tree...");
        console.log(`Owner: ${Config.getGitHubOrgName()}, Repo: ${repoName}`);
        
        // Build a tree structure that includes all necessary directory entries
        // GitHub's Git Data API requires explicit directory entries for nested paths
        type CreateTreeParams = Extract<Parameters<typeof octokit.rest.git.createTree>[0], { tree: any }>;
        type TreeEntry = NonNullable<CreateTreeParams['tree']>[number];
        const directories = new Set<string>();
        
        // First, collect all unique directories from the file paths
        for (const blob of blobs) {
            const pathParts = blob.path.split('/');
            // Remove the filename to get directory path
            pathParts.pop();
            // Build up the directory path incrementally
            let currentPath = '';
            for (const part of pathParts) {
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                directories.add(currentPath);
            }
        }
        
        console.log(`Directories to create:`, Array.from(directories));
        
        // Create subtrees for each directory level (bottom-up)
        const directoryShas = new Map<string, string>();
        const sortedDirectories = Array.from(directories).sort((a, b) => b.split('/').length - a.split('/').length);
        
        for (const dir of sortedDirectories) {
            // Get files and subdirectories in this directory
            const dirContents: TreeEntry[] = [];
            
            // Add files in this directory
            for (const blob of blobs) {
                const blobDir = blob.path.substring(0, blob.path.lastIndexOf('/'));
                if (blobDir === dir) {
                    const fileName = blob.path.substring(blob.path.lastIndexOf('/') + 1);
                    dirContents.push({
                        path: fileName,
                        mode: "100644",
                        type: "blob",
                        sha: blob.sha,
                    });
                }
            }
            
            // Add subdirectories
            for (const subDir of directories) {
                const subDirParts = subDir.split('/');
                const subDirParent = subDirParts.slice(0, -1).join('/');
                if (subDirParent === dir) {
                    const subdirName = subDirParts[subDirParts.length - 1];
                    const subdirSha = directoryShas.get(subDir);
                    if (subdirSha) {
                        dirContents.push({
                            path: subdirName,
                            mode: "040000",
                            type: "tree",
                            sha: subdirSha,
                        });
                    }
                }
            }
            
            if (dirContents.length > 0) {
                console.log(`Creating tree for directory: ${dir}`, dirContents);
                const { data: subDirTreeData } = await octokit.rest.git.createTree({
                    owner: Config.getGitHubOrgName(),
                    repo: repoName,
                    tree: dirContents,
                });
                directoryShas.set(dir, subDirTreeData.sha);
                console.log(`  Created subtree ${dir} with SHA: ${subDirTreeData.sha}`);
            }
        }
        
        // Now create the root tree with the top-level directories and files
        console.log("Creating root tree...");
        const rootTreeEntries: TreeEntry[] = [];
        
        // Add top-level files
        for (const blob of blobs) {
            if (!blob.path.includes('/')) {
                rootTreeEntries.push({
                    path: blob.path,
                    mode: "100644",
                    type: "blob",
                    sha: blob.sha,
                });
            }
        }
        
        // Add top-level directories
        for (const dir of directories) {
            if (!dir.includes('/')) {
                const dirSha = directoryShas.get(dir);
                if (dirSha) {
                    rootTreeEntries.push({
                        path: dir,
                        mode: "040000",
                        type: "tree",
                        sha: dirSha,
                    });
                }
            }
        }
        
        console.log("Root tree entries:", rootTreeEntries);
        
        const { data: treeData } = await octokit.rest.git.createTree({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            base_tree: baseTreeSha,  // This preserves existing files
            tree: rootTreeEntries,
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
        console.log(`✓ Commit created with SHA: ${newCommitData.sha}`);
        
        // Step 6: Update the branch to point to the new commit
        console.log("Updating branch...");
        console.log(`Updating ref: heads/${baseBranch} to SHA: ${newCommitData.sha}`);
        await octokit.rest.git.updateRef({
            owner: Config.getGitHubOrgName(),
            repo: repoName,
            ref: `heads/${baseBranch}`,
            sha: newCommitData.sha,
            force: true,  // Force update the reference
        });
        console.log("✓ Branch updated successfully");
        
        console.log(`✓ Successfully uploaded base files to ${repoName}`);
        processedCount++;
    } catch (e: any) {
        console.error(`\n✗✗✗ FATAL ERROR processing repository ${repoName} ✗✗✗`);
        console.error(`\nError Details:`);
        if (e.status) {
            console.error(`  HTTP Status: ${e.status}`);
        }
        if (e.message) {
            console.error(`  Message: ${e.message}`);
        }
        if (e.response) {
            console.error(`  Response Status: ${e.response.status}`);
            console.error(`  Response URL: ${e.response.url}`);
            if (e.response.data) {
                console.error(`  Response Data:`, JSON.stringify(e.response.data, null, 2));
            }
        }
        if (e.request) {
            console.error(`  Request:`, {
                method: e.request.method,
                url: e.request.url,
            });
        }
        console.error(`\nFull Error Object:`);
        console.error(e);
        console.error(`\nStack Trace:`);
        if (e.stack) {
            console.error(e.stack);
        }
        console.error(`\n🛑 Stopping execution on first error 🛑`);
        process.exit(1);
    }
}

console.log("\n=== Summary ===");
console.log(`Total students: ${roster.students.length}`);
console.log(`Successfully processed: ${processedCount}`);
console.log(`Errors: ${errorCount}`);
console.log(`Files uploaded per repository: ${baseFiles.length}`);

