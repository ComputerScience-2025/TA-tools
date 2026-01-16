import { Glob } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import { askForInternalRosterFile } from "./helper/roster-internal.ts";
import { Config } from "./helper/config.ts";

console.log("Uploading base files to repositories...");
console.log(`Base files directory: ${Config.repoBaseFilesDirectory}`);

let roster = await askForInternalRosterFile();
console.log(`Loaded roster with ${roster.students.length} students`);

// Display roster information
console.log("\n=== Roster Preview ===");
console.log(`Total students: ${roster.students.length}`);
if (roster.students.length > 0) {
    console.log("\nFirst few entries:");
    roster.students.slice(0, 3).forEach((student, index) => {
        console.log(`  ${index + 1}. ${student.fullName} (${student.userName}) - Section: ${student.section}`);
    });
    if (roster.students.length > 3) {
        console.log(`  ... and ${roster.students.length - 3} more students`);
    }
}

let confirmation = prompt("\nThis will upload base files to all entries in the roster. Continue? (yes/no): ");
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

// Process each student from the roster
let processedCount = 0;
let errorCount = 0;

for (let student of roster.students) {
    console.log(`\n--- Processing: ${student.fullName} (${student.userName}) ---`);

    if (!student.repoURL) {
        console.error(`Repository URL not found for student: ${student.fullName}`);
        errorCount++;
        continue;
    }

    const repoUrl = student.repoURL;
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || '';
    
    if (!repoName) {
        console.error(`Failed to extract repository name from URL: ${repoUrl}`);
        errorCount++;
        continue;
    }

    console.log(`Repository URL: ${repoUrl}`);
    console.log(`Repository Name: ${repoName}`);

    const baseBranch = "main";
    
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
                email: Config.GitHub.commitEmail(),
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

