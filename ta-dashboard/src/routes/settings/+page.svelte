<svelte:head>
    <title>Settings</title>
</svelte:head>

<script lang="ts">
    import {GITHUB_PAT} from "$lib/stores";

    const CLASSIC_TOKEN_CREATION_URL = "https://github.com/settings/tokens/new?description=TA%20Dashboard&scopes=repo";
</script>

<h1 class="title is-1">Settings</h1>
<p>All changes are saved automatically, instead please refresh the page to make sure the singletons are initialized with the latest parameters</p>

<hr>

<section>
    <h2 class="title is-2">GitHub</h2>

    <label for="GITHUB_PAT">GitHub Personal Access Token (Classic):</label>
    <input type="text" size="50" bind:value={$GITHUB_PAT} id="GITHUB_PAT" />

    <article class="message is-info mt-5">
        <div class="message-header">
            <p>Need a new token?</p>
        </div>
        <div class="message-body">
            <p class="mb-3">
                Create a classic token with the <code>repo</code> scope (full control of repositories).
            </p>
            <a class="button is-link" href={CLASSIC_TOKEN_CREATION_URL} target="_blank" rel="noopener">
                Create GitHub Token
            </a>
            <p class="is-size-7 mt-3">
                GitHub opens the token form with the description filled in and the <code>repo</code> checkbox checked.
                Paste the generated token into the field above.
            </p>
        </div>
    </article>
</section>

<hr>
