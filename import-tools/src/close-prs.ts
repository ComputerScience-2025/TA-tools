import {octokit} from "./service.ts";
import {Config} from "./config.ts";
import {Naming} from "./helper/naming.ts";


console.log("Closing Pull Requests in batch...");

let courseName = prompt("Enter the course name: ") ?? "YOU_FORGOT_TO_ENTER_A_COURSE_NAME";
let sectionName = prompt("Enter the section name: ") ?? "YOU_FORGOT_TO_ENTER_A_SECTION_NAME";
let titleFilter = prompt("Enter the string to search for in PR titles: ") ?? "";
let repoPrefix = Naming.repositoryNamePrefix({courseName, sectionName});

console.log(`Course: ${courseName}, Section: ${sectionName}, Repo Prefix: ${repoPrefix}`);
console.log(`Will close PRs containing: "${titleFilter}"`);

const confirmClose = prompt("Are you sure you want to close these PRs? (yes/no): ");
if (confirmClose?.toLowerCase() !== "yes") {
    console.log("Operation cancelled.");
    process.exit(0);
}

console.log("Getting repositories...");
let repos = await octokit.request("GET /orgs/{org}/repos", {
    org: Config.GitHub.organizationName(),
    per_page: 100, // TODO: pagination
});

let targetRepos = repos.data.filter(repo => repo.name.startsWith(repoPrefix));
console.log(`Found ${targetRepos.length} repositories matching prefix: ${repoPrefix}`);

let closedCount = 0;
let totalPRsFound = 0;

for (let repo of targetRepos) {
    console.log(`\nProcessing repository: ${repo.name}`);
    
    try {
        // Get all open pull requests for this repository
        const { data: pullRequests } = await octokit.rest.pulls.list({
            owner: Config.GitHub.organizationName(),
            repo: repo.name,
            state: "open",
            per_page: 100,
        });
        
        console.log(`  Found ${pullRequests.length} open PR(s)`);
        
        // Filter PRs by title
        const matchingPRs = pullRequests.filter(pr =>
            pr.title.includes(titleFilter)
        );
        
        if (matchingPRs.length === 0) {
            console.log(`  No PRs matching "${titleFilter}"`);
            continue;
        }
        
        totalPRsFound += matchingPRs.length;
        console.log(`  Found ${matchingPRs.length} matching PR(s)`);
        
        // Close each matching PR
        for (let pr of matchingPRs) {
            console.log(`  Closing PR #${pr.number}: "${pr.title}"`);
            
            await octokit.rest.pulls.update({
                owner: Config.GitHub.organizationName(),
                repo: repo.name,
                pull_number: pr.number,
                state: "closed",
            });
            
            console.log(`  ✓ Closed PR #${pr.number}`);
            closedCount++;
        }
    } catch (error) {
        console.error(`  Error processing repository ${repo.name}:`, error);
    }
}

console.log(`\n=== Summary ===`);
console.log(`Repositories processed: ${targetRepos.length}`);
console.log(`Total PRs found matching "${titleFilter}": ${totalPRsFound}`);
console.log(`PRs closed: ${closedCount}`);

