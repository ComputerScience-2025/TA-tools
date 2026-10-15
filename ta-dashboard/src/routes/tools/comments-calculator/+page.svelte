<svelte:head>
    <title>Comments Score Calculator</title>
</svelte:head>

<script lang="ts">
    import {page} from "$app/state";

    import {ArbitraryResultsTable} from "my-svelte-components";
    import {toast} from "@zerodevx/svelte-toast";

    import {GitHubWrapper} from "$lib/github";
    import type {GitHubPullRequestReviewCommentEntry, GitHubPullRequestReviewEntry} from "$lib/github";
    import {GITHUB_PAT} from "$lib/stores";

    const ERROR_TOAST_THEME = {
        "--toastBackground": "hsl(348, 86%, 43%)",
        "--toastColor": "#ffffff",
        "--toastBarBackground": "hsl(348, 86%, 30%)",
    };

    function describeError(e: unknown): string {
        if (!(e instanceof Error)) {
            return String(e);
        }
        const status = (e as Error & {status?: number}).status;
        return status === undefined ? e.message : `HTTP ${status}: ${e.message}`;
    }

    let pullRequestLink = $state("");
    let pullRequestReviews: GitHubPullRequestReviewEntry[] = $state([]);
    let pullRequestReviewComments: (GitHubPullRequestReviewCommentEntry&{score?: number})[] = $state([]);
    let owner = $state("");
    let repo = $state("");
    let pull_number = $state(0);

    let selectedCommentsIndexForTabulation: number[] = $state([]);
    let score: number = $derived(selectedCommentsIndexForTabulation.reduce((prev, curr) => {
        let comment = pullRequestReviewComments[curr];
        if (comment && comment.score !== undefined) {
            return prev + comment.score;
        }
        return prev;
    }, 0));

    let lmsComment: string = $derived(
        `See https://github.com/${owner}/${repo}/pull/${pull_number}/changes for detailed explanations about points deduction and suggestions. Let us know if you have any trouble accessing them.`
    );

    $effect(() => {
        let prLink = page.url.searchParams.get("pr_link");  // TODO: not hardcode the param name
        if (prLink) {
            pullRequestLink = prLink;
        }
    });

    function analyzePullRequestLink(): boolean {
        try {
            let resp = GitHubWrapper.analyzePullRequestLink(pullRequestLink);
            owner = resp.owner;
            repo = resp.repo;
            pull_number = resp.pull_number;
            return true;
        } catch (e) {
            toast.push(`Failed to analyze Pull Request link. ${describeError(e)}`, {theme: ERROR_TOAST_THEME});
            return false;
        }
    }

    async function getReviewsButton() {
        if (!analyzePullRequestLink()) {
            return;
        }

        try {
            pullRequestReviews = await GitHubWrapper.listReviews(owner, repo, pull_number);
        } catch (e) {
            toast.push(`Failed to get reviews. ${describeError(e)}`, {theme: ERROR_TOAST_THEME});
        }
    }

    async function getReviewCommentsButton(comment_id: number) {
        try {
            pullRequestReviewComments = await GitHubWrapper.listCommentsForReview(owner, repo, pull_number, comment_id);
        } catch (e) {
            toast.push(`Failed to get review comments. ${describeError(e)}`, {theme: ERROR_TOAST_THEME});
            return;
        }

        selectedCommentsIndexForTabulation = [];
        calculateIndividualScores();
    }

    function calculateIndividualScores(){
        for(let comment of pullRequestReviewComments){
            if (comment.score !== undefined){
                continue; // already calculated
            }

            const regex = /\((-?\d+(?:\.\d+)?)\)/g;

            const matches = [...comment.content.matchAll(regex)]; // Use matchAll to get capture groups
            const scores = matches.map(match => match[1]); // Extract the captured scores from group 1

            console.log(scores);
            comment.score = scores.reduce((acc, score) => acc + parseFloat(score), 0);
        }

    }

    async function copyLmsCommentButton() {
        try {
            await navigator.clipboard.writeText(lmsComment);
            toast.push("Comment copied to clipboard.");
        } catch (e) {
            toast.push("Failed to copy comment." + (e instanceof Error ? ` ${e.message}` : ""));
        }
    }
</script>

<h1 class="title">Comments Score Calculator</h1>

{#if !$GITHUB_PAT}
    <article class="message is-warning">
        <div class="message-header">
            <p>GitHub token is not configured</p>
        </div>
        <div class="message-body">
            Reading reviews and comments requires a GitHub Personal Access Token.
            Add one on the <a href="/settings">Settings</a> page, then reload this page.
        </div>
    </article>
{/if}

<hr>

<p>
    Pull Request Link:
    <input type="text" bind:value={pullRequestLink} size="50">

    <button class="button" onclick={getReviewsButton}>Get Reviews</button>

    Owner: {owner} Repo: {repo} PR Number: {pull_number}
</p>

<hr>

<section>
    {#if pullRequestReviews.length > 0}
        <h4 class="title is-4">Reviews</h4>
        <table>
            <thead>
            <tr>
                <th>Reviewer</th>
                <th>State</th>
                <th>Actions</th>
            </tr>
            </thead>
            <tbody>
            {#each pullRequestReviews as review}
                <tr>
                    <td>{review.person}</td>
                    <td>{review.status}</td>
                    <td><button class="button" onclick={() => getReviewCommentsButton(review.review_id)}>Get Comments</button></td>
                </tr>
            {/each}
            </tbody>
        </table>
    {:else}
        <p>No Reviews</p>
    {/if}
</section>

<hr>

<section>
    <ArbitraryResultsTable
            data={pullRequestReviewComments}
            dataLabels={[
                {elementType: "p", label: "File", dataKey: "filepath"},
                {elementType: "p", label: "Content", dataKey: "content"},
                {elementType: "p", label: "Score", dataKey: "score"},
            ]}
            selectRows={true}
            bind:selectedRowsIndex={selectedCommentsIndexForTabulation}
    />
    <p>
        <b>Total Score: {score}</b>
        <button class="button" onclick={copyLmsCommentButton} disabled={!pull_number}>Copy Comment for LMS</button>
    </p>
</section>

<hr>

<a href="/tools/links-opener">Back to Links Opener</a>
