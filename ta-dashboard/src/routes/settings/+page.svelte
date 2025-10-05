<svelte:head>
    <title>Settings</title>
</svelte:head>

<script lang="ts">
    import {GITHUB_PAT} from "$lib/stores";
</script>

<h1 class="title is-1">Settings</h1>
<p>All changes are saved automatically, instead please refresh the page to make sure the singletons are initialized with the latest parameters</p>

<hr>

<section>
    <h2 class="title is-2">GitHub</h2>

    <label for="GITHUB_PAT">GitHub Personal Access Token (Classic):</label>
    <input type="text" size="50" bind:value={$GITHUB_PAT} id="GITHUB_PAT" />
</section>

<hr>
