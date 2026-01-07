import {Octokit} from "octokit";
export {RequestError as OctokitRequestError} from "octokit";

if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN environment variable not set");
}

export const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});
