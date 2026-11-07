<script lang="ts">
	import { errorMessage } from "$epf/util/errors.ts";

	import type { Snippet } from "svelte";

	interface Props {
		children: Snippet;
		/** Heading shown when the section throws while rendering. */
		label?: string;
	}

	let { children, label = "This EPF section could not be shown" }: Props = $props();
</script>

<svelte:boundary>
	{@render children()}
	{#snippet failed(error, reset)}
		<article class="message is-danger">
			<div class="message-header"><p>{label}</p></div>
			<div class="message-body">
				<p>{errorMessage(error)}</p>
				<button type="button" class="button is-small mt-3" onclick={reset}>Try again</button>
			</div>
		</article>
	{/snippet}
</svelte:boundary>
