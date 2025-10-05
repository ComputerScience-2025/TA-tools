<script lang="ts">
    import {ArbitraryResultsTable} from "my-svelte-components";

    import {GitHubWrapper} from "$lib/github";
    import type {GitHubPullRequestReviewCommentEntry, GitHubPullRequestReviewEntry} from "$lib/github";

    let pullRequestLink = $state("");
    let pullRequestReviews: GitHubPullRequestReviewEntry[] = $state([]);
    let pullRequestReviewComments: (GitHubPullRequestReviewCommentEntry&{score?: number})[] = $state([]);
    let owner = $state("");
    let repo = $state("");
    let pull_number = $state(0);

    let selectedCommentsIndexForTabulation: number[] = $state([]);
    let score = $state(0);

    function analyzePullRequestLink(){
        let resp  = GitHubWrapper.analyzePullRequestLink(pullRequestLink);
        owner = resp.owner;
        repo = resp.repo;
        pull_number = resp.pull_number;
    }

    async function getReviewsButton() {
        analyzePullRequestLink();
        pullRequestReviews = await GitHubWrapper.listReviews(owner, repo, pull_number);
    }

    async function getReviewCommentsButton(comment_id: number){
        pullRequestReviewComments = await GitHubWrapper.listCommentsForReview(owner, repo, pull_number, comment_id);
        calculateIndividualScores()
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

        calculateAllScores();
    }

    function calculateAllScores() {
        let totalScore = 0;
        for (let index of selectedCommentsIndexForTabulation) {
            let comment = pullRequestReviewComments[index];
            if (comment.score !== undefined) {
                totalScore += comment.score;
            }
        }
        score = totalScore;
    }
</script>

<h1>Comments Score Calculator</h1>

<hr>

<p>
    Pull Request Link:
    <input type="text" bind:value={pullRequestLink} size="50">

    <button onclick={getReviewsButton}>Get Reviews</button>

    Owner: {owner} Repo: {repo} PR Number: {pull_number}
</p>

<hr>

<section>
    {#if pullRequestReviews.length > 0}
        <h2>Reviews</h2>
        <table>
            <thead>
            <tr>
                <th>Reviewer</th>
                <th>State</th>
                <th>Body</th>
                <th>Actions</th>
            </tr>
            </thead>
            <tbody>
            {#each pullRequestReviews as review}
                <tr>
                    <td>{review.person}</td>
                    <td>{review.status}</td>
                    <td>{review.content}</td>
                    <td><button onclick={() => getReviewCommentsButton(review.review_id)}>Get Comments</button></td>
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
            selectedRowsIndex={selectedCommentsIndexForTabulation}
    />
    <p>Total Score: {score}</p>
</section>
