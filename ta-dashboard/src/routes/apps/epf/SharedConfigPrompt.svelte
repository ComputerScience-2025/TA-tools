<script lang="ts">
	interface Props {
		url: string;
		error: string | null;
		loading: boolean;
		disabled: boolean;
		onLoad: () => void;
		onDismiss: () => void;
	}

	let { url, error, loading, disabled, onLoad, onDismiss }: Props = $props();
</script>

<article class="message is-info">
	<div class="message-header"><p>Config from this link</p></div>
	<div class="message-body">
		<p class="mb-2">This link wants to load a config from:</p>
		<p class="mb-2"><code style="word-break: break-all">{url}</code></p>
		<p class="help">
			Only load it if you trust the source. A config can contain API keys and provider
			settings, and its workflows will use them.
		</p>
		{#if error !== null}
			<p class="help is-danger mt-2">{error}</p>
		{/if}
		<div class="buttons mt-3">
			<button type="button" class="button is-small is-primary" onclick={onLoad} disabled={loading || disabled}>
				{loading ? "Loading…" : "Load config"}
			</button>
			<button type="button" class="button is-small" onclick={onDismiss} disabled={loading}>
				Dismiss
			</button>
		</div>
	</div>
</article>
