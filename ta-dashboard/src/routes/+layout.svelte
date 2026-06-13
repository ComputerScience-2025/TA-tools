<script lang="ts">
    import {SvelteToast} from "@zerodevx/svelte-toast";
    import "bulma/css/bulma.css";
    import "$lib/dark-theme.css";
    import favicon from "$lib/assets/favicon.svg";
    import {darkMode} from "$lib/stores";

    // Import syntax highlighting styles as inline strings
    import githubLight from "highlight.js/styles/github.css?inline";
    import githubDark from "highlight.js/styles/github-dark.css?inline";

    let { children } = $props();

    $effect(() => {
        document.documentElement.setAttribute(
            "data-theme",
            $darkMode ? "dark" : "light",
        );
    });
</script>

<svelte:head>
    <link rel="icon" href={favicon} />
    {@html `<style>${$darkMode ? githubDark : githubLight}</style>`}
</svelte:head>

<SvelteToast />

{@render children?.()}
