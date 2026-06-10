<script lang="ts">
    import {SvelteToast} from "@zerodevx/svelte-toast";
    import "bulma/css/bulma.css";
    import "$lib/dark-theme.css";
    import favicon from "$lib/assets/favicon.svg";
    import {darkMode} from "$lib/stores";

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
</svelte:head>

<SvelteToast />

{@render children?.()}
