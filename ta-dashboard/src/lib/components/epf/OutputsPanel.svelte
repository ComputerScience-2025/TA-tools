<script lang="ts">
	import { onMount } from "svelte";

	import { errorMessage } from "$epf/util/errors.ts";

	import FileBrowser from "$lib/components/FileBrowser.svelte";
	import SessionChat from "$lib/components/epf/SessionChat.svelte";
	import { epfSession } from "$lib/epf/session";
	import { createVfsFileSource } from "$lib/results/file-sources";

	import type { ResultFileSource } from "$lib/results/file-sources";

	const { activeWorkspace, files, busy, chatSessions, writeBlocked, workspaceMissing } = epfSession;
	let source = $state<ResultFileSource | null>(null);
	let message = $state("");
	let view = $state<"files" | "chats">("files");
	const canWrite = $derived($writeBlocked === null);

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
				source = createVfsFileSource(epfSession, "browser workspace");
			} catch (err) {
				message = errorMessage(err);
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
			message = errorMessage(err);
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
	{#if view === "files"}
		<div class="buttons mb-0">
			<a class="button is-small is-light" href="/tools/results-viewer#source=workspace">Open in Results Viewer</a>
			<button class="button is-small is-light" onclick={() => void clearOutputs()} disabled={$busy || !canWrite}>Clear outputs</button>
		</div>
	{/if}
</div>

{#if $workspaceMissing}
	<article class="message is-warning is-small">
		<div class="message-body">
			<p>
				This workspace's directory is not in browser storage, so there are no files to show.
				It may have been evicted by the storage limit, or created by another tab that has not
				saved it yet.
			</p>
			{#if !canWrite}
				<p class="help mt-1">
					This tab is read-only; take over storage (or reload once the other tab is closed).
				</p>
			{/if}
		</div>
	</article>
{/if}

<div class="buttons has-addons mb-4">
	<button
		type="button"
		class={"button is-small" + (view === "files" ? " is-primary" : " is-light")}
		onclick={() => (view = "files")}
	>
		Files
	</button>
	<button
		type="button"
		class={"button is-small" + (view === "chats" ? " is-primary" : " is-light")}
		onclick={() => (view = "chats")}
	>
		Chats
		{#if $chatSessions.length > 0}
			<span class="tag is-rounded is-small ml-2">{$chatSessions.length}</span>
		{/if}
	</button>
</div>

{#if view === "files"}
	{#if source !== null}
		<FileBrowser {source} emptyMessage="No outputs yet. Run a workflow from the Console tab." showControls={true} />
	{:else}
		<p>Loading the workspace…</p>
	{/if}
{:else}
	<SessionChat />
{/if}

{#if message.length > 0}
	<article class="message is-info is-small">
		<div class="message-body">{message}</div>
	</article>
{/if}
