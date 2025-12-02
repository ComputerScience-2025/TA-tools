import { Glob } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import { askForInternalRosterFile } from "./helper/roster-internal.ts";
import { Naming } from "./helper/naming.ts";
import { octokit } from "./service.ts";
import { Config } from "./config.ts";

console.log("Uploading base files to repositories...");
console.log(`Base files directory: ${Config.repoBaseFilesDirectory}`);

let roster = await askForInternalRosterFile();
console.log(`Loaded roster with ${roster.students.length} students`);

let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let repoPrefix = Naming.repositoryNamePrefix({ courseName, sectionName });
console.log(`Course: ${courseName}, Section: ${sectionName}, Repo Prefix: ${repoPrefix}`);

let confirmation = prompt("This will upload base files to all student repositories. Continue? (yes/no): ");
if (confirmation !== "yes") {
    console.log("Exiting...");
    process.exit(1);
}

// Collect all files from the base files directory
console.log("Scanning base files directory...");
let baseFiles: { relativePath: string, fullPath: string }[] = [];

for await (const filepath of new Glob(`${Config.repoBaseFilesDirectory}/**/*`).scan({ cwd: ".", dot: true, onlyFiles: true })) {
    console.log(`Glob found file: ${filepath}`);
    const file = Bun.file(filepath);
    if (await file.exists()) {
        // Remove the base directory prefix to get relative path
        const relativePath = filepath.replaceAll("\\", "/").replace(`${Config.repoBaseFilesDirectory}/`, "");
        if (relativePath === "") {
            throw new Error(`Relative path is empty for file: ${filepath}`);
        }
        if (relativePath === filepath) {
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
    console.log(`Organization: ${Config.GitHub.organizationName()}`);

    const baseBranch = "main";
    const repoUrl = `https://github.com/${Config.GitHub.organizationName()}/${repoName}.git`;
    
    const dir = `./temp/repo-${repoName}`;

    try {
        // Step 1: Create working directory
        console.log("Creating working directory in virtual FS...");
        await fs.promises.mkdir(dir, {recursive: true});

        // Step 2: Clone the repository (shallow clone for efficiency)
        console.log(`Cloning repository from ${repoUrl}...`);
        await git.clone({
            fs,
            http,
            dir,
            url: repoUrl,
            ref: baseBranch,
            singleBranch: true,
            depth: 1,
            onAuth: () => ({
                username: Config.GitHub.username(),
                password: Config.GitHub.token(),
            })
        });
        console.log("✓ Clone complete");

        // Step 3: Copy base files to the working directory
        console.log(`Copying ${baseFiles.length} files to repository...`);
        for (const fileToAdd of baseFiles) {
            const targetPath = `${dir}/${fileToAdd.relativePath}`;
            // const targetDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
            const targetDir = path.dirname(targetPath);

            // Create nested directories if needed
            if (targetDir !== dir) {
                console.log(`  Creating directory: ${targetDir.replace(dir + '/', '')}`);
                await fs.promises.mkdir(targetDir, { recursive: true });
            }

            // Read file content from local filesystem
            const fileContent = await Bun.file(fileToAdd.fullPath).text();

            // Write to virtual filesystem
            console.log(`  Writing file: ${fileToAdd.relativePath}`);
            await fs.promises.writeFile(targetPath, fileContent, 'utf8');

            // Stage the file
            await git.add({ fs, dir, filepath: fileToAdd.relativePath });
            console.log(`  ✓ Staged: ${fileToAdd.relativePath}`);
        }

        // Step 4: Check if there are changes to commit
        console.log("Checking for changes...");
        const status = await git.statusMatrix({ fs, dir });
        const hasChanges = status.some(row => row[1] !== row[2] || row[2] !== row[3]);

        if (!hasChanges) {
            console.log("ℹ No changes detected, skipping commit");
            processedCount++;
            continue;
        }

        // Step 5: Create a commit
        console.log("Creating commit...");
        const commitSha = await git.commit({
            fs,
            dir,
            message: `Update base files`,
            author: {
                name: Config.GitHub.username(),
                email: "1@2.3"
            }
        });
        console.log(`✓ Commit created with SHA: ${commitSha}`);

        // Step 6: Push to GitHub
        console.log("Pushing to GitHub...");
        await git.push({
            fs,
            http,
            dir,
            remote: "origin",
            ref: baseBranch,
            onAuth: () => ({
                username: Config.GitHub.username(),
                password: Config.GitHub.token(),
            })
        });
        console.log("✓ Push complete");

        console.log(`✓ Successfully uploaded base files to ${repoName}`);
        processedCount++;
    } catch (e: any) {
        console.error(`\n✗✗✗ ERROR processing repository ${repoName} ✗✗✗`);
        console.error(`\nError Details:`);
        if (e.message) {
            console.error(`  Message: ${e.message}`);
        }
        if (e.code) {
            console.error(`  Code: ${e.code}`);
        }
        if (e.data) {
            console.error(`  Data:`, e.data);
        }
        console.error(`\nFull Error Object:`);
        console.error(e);
        if (e.stack) {
            console.error(`\nStack Trace:`);
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

