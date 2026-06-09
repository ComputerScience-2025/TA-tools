<script lang="ts">
    import {toast} from "@zerodevx/svelte-toast";
    import {goto} from "$app/navigation";

    let repositoryBaseURL = $state("");
    let pullRequestNumber = $state("");
    let branchName = $state("");

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
<p>
    Pull Request Number: <input type="text" bind:value={pullRequestNumber} />
</p>
<p>
    Branch Name: <input type="text" bind:value={branchName} />
</p>

<button class="button" onclick={openLinksButton}>Open Links</button>
<button class="button" onclick={openCommentScoreCalculator}>Open Comments Score Calculator</button>
