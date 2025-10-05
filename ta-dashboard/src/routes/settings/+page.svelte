<script lang="ts">
    import {GITHUB_PAT} from "$lib/stores";
</script>

<h1>Settings</h1>

<hr>

<section>
    <h2>GitHub</h2>

    <label for="GITHUB_PAT">GitHub Personal Access Token (PAT):</label>
    <input type="text" size="50" bind:value={$GITHUB_PAT} id="GITHUB_PAT" />
    <p>Please Refresh After reset</p>
</section>

<hr>
