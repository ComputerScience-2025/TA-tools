<script lang="ts">
    import {type GitHubPullRequestReviewEntry, GitHubWrapper} from "$lib/github";

    let pullRequestLink = $state("");
    let pullRequestReviews: GitHubPullRequestReviewEntry[] = $state([]);
    let owner = $state("");
    let repo = $state("");
    let pull_number = $state(0);

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
