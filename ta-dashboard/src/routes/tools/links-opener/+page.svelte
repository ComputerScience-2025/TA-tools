<script lang="ts">
    import {toast} from "@zerodevx/svelte-toast";
    import {goto} from "$app/navigation";

    let repositoryBaseURL = $state("");
    let pullRequestNumber = $state("");
    let branchName = $state("");

    function validateRepositoryBaseURL(url: string): string[] {
        const trimmed = url.trim();
        if (!trimmed) {
            return [];
        }

        const warnings: string[] = [];

        let parsed: URL | null = null;
        try {
            parsed = new URL(trimmed);
        } catch {
            // Tolerate protocol-less input (e.g. "github.com/owner/repo") for validation.
            try {
                parsed = new URL(`https://${trimmed}`);
            } catch {
                warnings.push("Repository Base URL is not a valid URL.");
                return warnings;
            }
        }

        if (parsed.hostname !== "github.com") {
            warnings.push("Domain is not github.com — the github.dev link rewrite will not apply and opened links may be invalid.");
        }

        const pathSegments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
        if (pathSegments.length !== 2) {
            warnings.push("URL does not point to a repository root (github.com/owner/repo) — it appears to be on another page of the repo.");
        }

        if (parsed.pathname.endsWith("/")) {
            warnings.push("URL has a trailing slash — opened links will contain a double slash (e.g. //pull/1).");
        }

        return warnings;
    }

    let repositoryBaseURLWarnings = $derived(validateRepositoryBaseURL(repositoryBaseURL));

    function openToNewTab(url: string) {
        window.open(url, '_blank');
    }

    function openLinksButton() {
        if (!repositoryBaseURL) {
            toast.push("Repository Base URL is required.");
            return;
        }

        if (pullRequestNumber) {
            openToNewTab(`${repositoryBaseURL.replace("github.com", "github.dev")}/pull/${pullRequestNumber}`);
            openToNewTab(`${repositoryBaseURL}/pull/${pullRequestNumber}`);
            openToNewTab(`${repositoryBaseURL}/pull/${pullRequestNumber}/files`);
            openToNewTab(`${repositoryBaseURL}/pull/${pullRequestNumber}/checks`);
        }

        if (branchName) {
            const branchURL = `${repositoryBaseURL}/tree/${branchName}`;
            openToNewTab(branchURL);
        }
    }

    function openCommentScoreCalculator() {
        if (!repositoryBaseURL) {
            toast.push("Repository Base URL is required.");
            return;
        }

        if (!pullRequestNumber){
            toast.push("Pull Request Number is required to open Comments Score Calculator.");
            return;
        }

        const calculatorURL = `/tools/comments-calculator?pr_link=${encodeURIComponent(`${repositoryBaseURL}/pull/${pullRequestNumber}`)}`;
        goto(calculatorURL);
    }
</script>

<h1 class="title">Links Opener</h1>

<h4 class="subtitle">Note: it will open multiple new tabs, please make sure to "Allow Popup"</h4>

<p>
    Repo URL: <input type="text" bind:value={repositoryBaseURL} size="100" />
</p>
{#if repositoryBaseURLWarnings.length > 0}
    <ul class="has-text-warning-dark">
        {#each repositoryBaseURLWarnings as warning}
            <li>⚠ {warning}</li>
        {/each}
    </ul>
{/if}
<p>
    Pull Request Number: <input type="text" bind:value={pullRequestNumber} />
</p>
<p>
    Branch Name: <input type="text" bind:value={branchName} />
</p>

<button class="button" onclick={openLinksButton}>Open Links</button>
<button class="button" onclick={openCommentScoreCalculator}>Open Comments Score Calculator</button>
