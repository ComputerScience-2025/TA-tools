import {Octokit} from "octokit";
export {RequestError as OctokitRequestError} from "octokit";

const GITHUB_API_VERSION = "2022-11-28";

if (!process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN environment variable not set");
}

export const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

octokit.hook.wrap("request", async (request, options) => {
    options.headers = {
        ...options.headers,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    return request(options);
});
