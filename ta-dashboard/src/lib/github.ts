import {get} from "svelte/store";

import {Octokit} from "octokit";

import {GITHUB_PAT} from "$lib/stores";

let octokit = new Octokit({
    auth: get(GITHUB_PAT),
});

// TODO: pagination
export const GitHubWrapper = {
    analyzePullRequestLink: (url: string) => {
        let urlObj = new URL(url);
        let pathParts = urlObj.pathname.split("/").filter(part => part.length > 0);
        if (pathParts.length < 4 || pathParts[2] !== "pull") {
            throw new Error("Invalid pull request URL");
        }
        let owner = pathParts[0];
        let repo = pathParts[1];
        let pull_number = parseInt(pathParts[3]);
        if (isNaN(pull_number)) {
            throw new Error("Invalid pull request number");
        }
        return {owner, repo, pull_number};
    },
    listReviews: async (owner: string, repo: string, pull_number: number): Promise<GitHubPullRequestReviewEntry[]> => {
        let resp =  await octokit.rest.pulls.listReviews({
            owner,
            repo,
            pull_number,
            per_page: 100,
        });
        
        return resp.data.map(review => ({
            review_id:  review.id,
            person: review.user?.login || "unknown",
            status: review.state,
            content: review.body || "",
        }));
    },
    listCommentsForReview: async (owner: string, repo: string, pull_number: number, review_id: number): Promise<GitHubPullRequestReviewCommentEntry[]> => {
        return (await octokit.rest.pulls.listCommentsForReview({
            owner,
            repo,
            pull_number,
            review_id: review_id,
            per_page: 100,
        })).data.map(comment => ({
            review_id: review_id,
            comment_id: comment.id,
            person: comment.user?.login || "unknown",
            content: comment.body || "",
            filepath: comment.path || "unknown",
        }));
    }
}

export type GitHubPullRequestReviewEntry = {
    review_id: number,
    person: string,
    status: string,
    content: string,
}

export type GitHubPullRequestReviewCommentEntry = {
    review_id: number,
    comment_id: number,
    person: string,
    content: string,
    filepath: string,
}
