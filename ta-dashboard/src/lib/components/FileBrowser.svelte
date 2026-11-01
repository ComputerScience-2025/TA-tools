<script lang="ts">
	import { onMount } from "svelte";
	import DOMPurify from "dompurify";

	import { marked, preprocessMarkdown } from "$lib/marked-config";
	import { enableMultilineTableCode, escapePipesInTableCode } from "$lib/stores";
	import type { ResultFileEntry, ResultFileSource } from "$lib/results/file-sources";

	type LoadState = "idle" | "loading" | "ready" | "error";

	let {
		source,
		emptyMessage = "No files",
		showControls = true
	}: {
		source: ResultFileSource;
		emptyMessage?: string;
		showControls?: boolean;
	} = $props();

	let fileList = $state<ResultFileEntry[]>([]);
	let selectedName = $state("");
	let selectedType = $state<"markdown" | "text">("markdown");
	let fileContent = $state("");
	let renderedHtml = $state("");
	let fileLoadState = $state<LoadState>("idle");
	let listLoadState = $state<LoadState>("loading");
	let listErrorMessage = $state("");
	let fileErrorMessage = $state("");
	let isFetching = $state(false);

	let selectedModificationTime = $derived(
		fileList.find((file) => file.name === selectedName)?.modification_time ?? ""
	);

	// The table toggles are read inside preprocessMarkdown (a plain store read),
	// so depend on them here to make the render effect re-run when they change.
	let tableOptionsKey = $derived(`${$enableMultilineTableCode ? 1 : 0}${$escapePipesInTableCode ? 1 : 0}`);

	$effect(() => {
		const content = fileContent;
		const type = selectedType;
		const optionsKey = tableOptionsKey;
		void optionsKey;
		let active = true;

		if (type === "markdown" && content) {
			const parseMarkdown = async () => {
				try {
					const html = await marked.parse(preprocessMarkdown(content));
					// Files can come from a fetched repository, so the rendered HTML is
					// sanitized before it reaches {@html}.
					const safeHtml = DOMPurify.sanitize(html);
					if (active) {
						renderedHtml = safeHtml;
					}
				} catch (err) {
					console.error(err);
					if (active) {
						renderedHtml = "";
					}
				}
			};
			void parseMarkdown();
		} else {
			renderedHtml = "";
		}

		return () => {
			active = false;
		};
	});

	const refreshList = async (): Promise<void> => {
		if (isFetching) {
			return;
		}
		isFetching = true;
		try {
			// Only show the loading state on the initial fetch (no files yet).
			if (fileList.length === 0) {
				listLoadState = "loading";
			}
			const entries = await source.list();
			const previousSelected = selectedName;
			const previousModTime = fileList.find((file) => file.name === previousSelected)?.modification_time ?? "";
			fileList = entries;
			listLoadState = "ready";
			listErrorMessage = "";

			// A click can land while the list request is in flight; never
			// overwrite the user's newer selection with this result.
			if (selectedName !== previousSelected) {
				return;
			}

			const currentEntry = fileList.find((file) => file.name === previousSelected);
			if (previousSelected.length > 0 && currentEntry !== undefined) {
				// If the source updated the selected file, refresh its content in the
				// background WITHOUT touching selectedName.
				if (currentEntry.modification_time !== previousModTime) {
					const content = await source.read(previousSelected);
					if (selectedName === previousSelected) {
						selectedType = content.type;
						fileContent = content.content;
					}
				}
				return;
			}
			if (previousSelected.length > 0 && currentEntry === undefined) {
				// The selected file was removed (clear outputs, re-run, another tab)
				// while other files may remain. Drop the stale content instead of
				// showing a deleted file.
				selectedName = "";
				fileContent = "";
				renderedHtml = "";
				fileLoadState = "idle";
				fileErrorMessage = "";
			}
			if (fileList.length > 0) {
				await selectFile(fileList[0]!.name);
			}
		} catch (err) {
			listLoadState = "error";
			listErrorMessage = err instanceof Error ? err.message : "Failed to load the file list";
		} finally {
			isFetching = false;
		}
	};

	const selectFile = async (name: string): Promise<void> => {
		selectedName = name;
		try {
			fileLoadState = "loading";
			const content = await source.read(name);
			selectedType = content.type;
			fileContent = content.content;
			fileLoadState = "ready";
			fileErrorMessage = "";
		} catch (err) {
			fileLoadState = "error";
			fileErrorMessage = err instanceof Error ? err.message : "Failed to load the file";
			fileContent = "";
		}
	};

	onMount(() => {
		void refreshList();
		if (source.refreshIntervalMs === null) {
			return;
		}
		const timer = setInterval(() => void refreshList(), source.refreshIntervalMs);
		return () => clearInterval(timer);
	});
</script>

<div class="is-flex is-justify-content-space-between is-align-items-center mb-4">
	<p class="subtitle mb-0">Viewing outputs from <code>{source.label}</code></p>
	{#if showControls}
		<div class="is-flex is-align-items-center">
			<label class="checkbox mr-4 label-text" for="escape-pipes-toggle">
				<input
					type="checkbox"
					checked={$escapePipesInTableCode}
					onchange={(e) => escapePipesInTableCode.set(e.currentTarget.checked)}
					id="escape-pipes-toggle"
					class="mr-2"
				/>
				Escape Table Pipes
			</label>
			<label class="checkbox mr-4 label-text" for="multiline-toggle">
				<input
					type="checkbox"
					checked={$enableMultilineTableCode}
					onchange={(e) => enableMultilineTableCode.set(e.currentTarget.checked)}
					id="multiline-toggle"
					class="mr-2"
				/>
				Table Code Blocks
			</label>
		</div>
	{/if}
</div>

{#if listLoadState === "error"}
	<article class="message is-danger">
		<div class="message-header">
			<p>Unable to load files</p>
		</div>
		<div class="message-body">{listErrorMessage}</div>
	</article>
{/if}

{#if fileList.length > 0}
	<div class="columns">
		<div class="column is-2">
			<aside class="menu">
				<p class="menu-label">Files ({fileList.length})</p>
				<ul class="menu-list file-list">
					{#each fileList as file (file.name)}
						<li>
							<button
								class={"button is-text is-fullwidth has-text-left menu-item-btn" + (selectedName === file.name ? " is-active" : "")}
								onclick={() => void selectFile(file.name)}
							>
								<span class="is-family-monospace">{file.name}</span>
								<span class="tag is-small is-light ml-2">{file.type}</span>
							</button>
						</li>
					{/each}
				</ul>
			</aside>
		</div>

		<div class="column is-10" style="min-width: 0; flex-shrink: 1;">
			{#if fileLoadState === "loading"}
				<progress class="progress is-small is-info" max="100"></progress>
			{:else if fileLoadState === "error"}
				<article class="message is-danger">
					<div class="message-header"><p>Failed to load file</p></div>
					<div class="message-body">{fileErrorMessage}</div>
				</article>
			{:else if fileLoadState === "ready"}
				<div class="box" style="overflow-x: auto;">
					<p class="has-text-weight-semibold is-family-monospace mb-3">
						{selectedName}
						{#if selectedModificationTime}
							<span class="is-size-7 has-text-grey ml-2">{selectedModificationTime}</span>
						{/if}
					</p>
					{#if selectedType === "markdown"}
						<div class="content">
							{@html renderedHtml}
						</div>
					{:else}
						<pre class="raw-text">{fileContent}</pre>
					{/if}
				</div>
			{:else}
				<article class="message is-info">
					<div class="message-body">Select a file from the sidebar to view its contents.</div>
				</article>
			{/if}
		</div>
	</div>
{:else if listLoadState === "loading"}
	<p class="is-size-7 has-text-grey">Loading files…</p>
{:else if listLoadState !== "error"}
	<p>{emptyMessage}</p>
{/if}

<style>
	.file-list {
		max-height: 80vh;
		overflow-y: auto;
	}

	.file-list .menu-item-btn {
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.file-list .menu-item-btn.is-active {
		background-color: #485fc7;
		color: #fff;
	}

	.file-list .menu-item-btn.is-active .tag {
		background-color: rgba(255, 255, 255, 0.2);
		color: #fff;
	}

	.menu-item-btn {
		background: none;
		border: none;
		text-align: left;
		padding: 0.5em 0.75em;
		font-size: 0.9rem;
	}

	.raw-text {
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 0.875rem;
	}

	/* Remove the extra border Bulma adds around <pre> blocks — the hljs background
	   already provides sufficient visual separation */
	:global(.content pre) {
		border: none;
		padding: 0;
	}

	/* Label styles */
	.label-text {
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--bulma-text);
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		user-select: none;
	}
</style>
