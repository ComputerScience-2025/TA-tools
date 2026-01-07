import {octokit} from "./helper/service.ts";

console.log("Checking GitHub token scopes...");

try {
    const response = await octokit.request("GET /user");
    console.log("Authenticated as:", response.data.login);
    console.log("Response headers:");
    console.log("X-OAuth-Scopes:", response.headers["x-oauth-scopes"]);
    console.log("X-Accepted-OAuth-Scopes:", response.headers["x-accepted-oauth-scopes"]);
} catch (error) {
    console.error("Error checking token:", error);
}

