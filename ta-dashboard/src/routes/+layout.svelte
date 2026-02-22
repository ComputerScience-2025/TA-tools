<script lang="ts">
    import {SvelteToast} from "@zerodevx/svelte-toast";
    import "bulma/css/bulma.css";
	import favicon from "$lib/assets/favicon.svg";

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<SvelteToast />

{@render children?.()}
