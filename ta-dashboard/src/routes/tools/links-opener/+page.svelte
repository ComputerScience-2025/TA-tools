<script lang="ts">
    import {toast} from "@zerodevx/svelte-toast";
    import {goto} from "$app/navigation";

    let repositoryBaseURL = $state("");
    let pullRequestNumber = $state("");
    let branchName = $state("");

    function openToNewTal(url: string) {
        window.open(url, '_blank');
    }

    function openLinksButton() {
        if (!repositoryBaseURL) {
            toast.push("Repository Base URL is required.");
            return;
        }

        if (pullRequestNumber) {
            const prVCSWebURL = `${repositoryBaseURL.replace("github.com", "github.dev")}/pull/${pullRequestNumber}`;
            const prFilesTabURL = `${repositoryBaseURL}/pull/${pullRequestNumber}/files`;
            openToNewTal(prVCSWebURL);
            openToNewTal(prFilesTabURL);
        }

        if (branchName) {
            const branchURL = `${repositoryBaseURL}/tree/${branchName}`;
            openToNewTal(branchURL);
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
