<script lang="ts">
	import { onMount } from "svelte";

	import FileBrowser from "$lib/components/FileBrowser.svelte";
	import { epfSession } from "$lib/epf/session";
	import { createVfsFileSource } from "$lib/results/file-sources";

	import type { ResultFileSource } from "$lib/results/file-sources";

	const { activeWorkspace, files, busy } = epfSession;
	let source = $state<ResultFileSource | null>(null);
	let message = $state("");

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
				source = createVfsFileSource(epfSession, "browser workspace");
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
		})();
	});

	const clearOutputs = async (): Promise<void> => {
		if ($busy) {
			return;
		}
		if (!confirm("Delete the output files this workspace recorded?")) {
			return;
		}
		try {
			await epfSession.clearOutputs();
			message = "Output files removed. Sources and config were kept.";
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
	};
</script>

<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
	<div>
		<p class="is-size-7 has-text-grey">
			Active workspace: <code>{$activeWorkspace?.label ?? "(none)"}</code> ·
			{$files.length} file(s) in the workspace
		</p>
	</div>
	<div class="buttons mb-0">
		<a class="button is-small is-light" href="/tools/results-viewer#source=workspace">Open in Results Viewer</a>
		<button class="button is-small is-light" onclick={() => void clearOutputs()} disabled={$busy}>Clear outputs</button>
	</div>
</div>

{#if source !== null}
	<FileBrowser {source} emptyMessage="No outputs yet. Run a workflow from the Console tab." showControls={true} />
{:else}
	<p>Loading the workspace…</p>
{/if}

{#if message.length > 0}
	<article class="message is-info is-small">
		<div class="message-body">{message}</div>
	</article>
{/if}
