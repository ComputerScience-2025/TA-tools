export const Config = {
    GitHub: {
        username() {
            if (!process.env.GITHUB_USERNAME) {
                throw new Error("GITHUB_USERNAME environment variable not set");
            }
            return process.env.GITHUB_USERNAME;
        },
        token() {
            if (!process.env.GITHUB_TOKEN) {
                throw new Error("GITHUB_TOKEN environment variable not set");
            }
            return process.env.GITHUB_TOKEN;
        },
        commitEmail() {
            if (!process.env.GITHUB_COMMIT_EMAIL) {
                throw new Error("GITHUB_COMMIT_EMAIL environment variable not set");
            }
            return process.env.GITHUB_COMMIT_EMAIL;
        },
        organizationName() {
            if (!process.env.IMPTTOOLS_GH_ORG) {
                throw new Error("IMPTTOOLS_GH_ORG environment variable not set");
            }
            return process.env.IMPTTOOLS_GH_ORG;
        },
    },
    submissionInputDirectory: "./submissions",
    repoBaseFilesDirectory: "./repo_base_files",
}
