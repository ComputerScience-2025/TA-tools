export const Config = {
    getGitHubOrgName: () => {
        if (!process.env.IMPTTOOLS_GH_ORG) {
            throw new Error("IMPTTOOLS_GH_ORG environment variable not set");
        }
        return process.env.IMPTTOOLS_GH_ORG;
    }
}
