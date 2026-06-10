<svelte:head>
	<title>Results Viewer</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";
	import { marked } from "marked";

	import { darkMode } from "$lib/stores";
	import { page } from "$app/state";


	type FileEntry = { name: string; type: "markdown" | "text" };
	type LoadState = "idle" | "loading" | "ready" | "error";

	let apiBase = $derived(page.url.searchParams.get("api")?.replace(/\/+$/, "") ?? "");
	let fileList = $state<FileEntry[]>([]);
	let selectedName = $state("");
	let selectedType = $state<"markdown" | "text">("markdown");
	let fileContent = $state("");
	let renderedHtml = $state("");
	let fileLoadState = $state<LoadState>("idle");
	let listLoadState = $state<LoadState>("idle");
	let errorMessage = $state("");

	let fetchFileList = async () => {
		if (!apiBase) return;
		try {
			listLoadState = "loading";
			let res = await fetch(`${apiBase}/`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			let data = await res.json();
			let newFiles: FileEntry[] = data.files ?? data;
			let prevSelected = selectedName;
			fileList = newFiles;
			listLoadState = "ready";
			if (prevSelected && fileList.some((f) => f.name === prevSelected)) {
				return;
			}
			if (!selectedName && fileList.length > 0) {
				await selectFile(fileList[0].name);
			}
		} catch (err) {
			listLoadState = "error";
			errorMessage =
				err instanceof Error
					? err.message
					: "Failed to fetch file list";
		}
	};

	let selectFile = async (name: string) => {
		if (!apiBase) return;
		selectedName = name;
		try {
			fileLoadState = "loading";
			let res = await fetch(`${apiBase}/${encodeURIComponent(name)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			let data = await res.json();
			selectedType = data.type ?? "markdown";
			fileContent = data.content ?? "";
			if (selectedType === "markdown") {
				renderedHtml = await marked.parse(fileContent);
			} else {
				renderedHtml = "";
			}
			fileLoadState = "ready";
		} catch (err) {
			fileLoadState = "error";
			errorMessage =
				err instanceof Error ? err.message : "Failed to fetch file";
			fileContent = "";
			renderedHtml = "";
		}
	};

	let refreshInterval: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		if (!apiBase) {
			listLoadState = "error";
			errorMessage = "No API URL provided. Add ?api=http://localhost:PORT to the URL.";
			return;
		}
		void fetchFileList();
		refreshInterval = setInterval(() => void fetchFileList(), 3000);
		return () => {
			if (refreshInterval) {
				clearInterval(refreshInterval);
			}
		};
	});
</script>

<section class="section" style="padding: 0">
	<div class="container is-fluid">
		<div class="is-flex is-justify-content-space-between is-align-items-center mb-4">
			<div>
				<p class="subtitle mb-0">
					Viewing outputs from
					{#if apiBase}
						<code>{apiBase}</code>
					{:else}
						<em>no API URL</em>
					{/if}
				</p>
			</div>
			<button
				class="button is-light"
				onclick={() => darkMode.update(v => !v)}
				title={$darkMode ? "Switch to light mode" : "Switch to dark mode"}
			>
				{$darkMode ? "☀️ Light" : "🌙 Dark"}
			</button>
		</div>

		{#if !apiBase}
			<article class="message is-warning">
				<div class="message-body">
					Provide an API URL as a query parameter, e.g.
					<code>?api=http://localhost:3000</code>
				</div>
			</article>
		{:else if listLoadState === "error"}
			<article class="message is-danger">
				<div class="message-header">
					<p>Unable to connect to API</p>
				</div>
				<div class="message-body">{errorMessage}</div>
			</article>
		{/if}
		{#if fileList.length > 0}
			<div class="columns">
				<div class="column is-3">
					<aside class="menu">
						<p class="menu-label">Files ({fileList.length})</p>
						<ul class="menu-list file-list">
							{#each fileList as file (file.name)}
								<li>
									<button
										class="button is-text is-fullwidth has-text-left menu-item-btn"
										class:is-active={selectedName === file.name}
										onclick={() => void selectFile(file.name)}
									>
										<span class="is-family-monospace">{file.name}</span>
										<span class="tag is-small is-light ml-2">{file.type}</span>
									</button>
								</li>
							{:else}
								{#if listLoadState === "ready"}
									<li>
										<p class="has-text-grey px-3">
											No files yet. Waiting for output...
										</p>
									</li>
								{:else}
									<li>
										<p class="has-text-grey px-3">
											Loading...
										</p>
									</li>
								{/if}
							{/each}
						</ul>
					</aside>
				</div>

				<div class="column is-9">
					{#if fileLoadState === "loading"}
						<progress class="progress is-small is-info" max="100"></progress>
					{:else if fileLoadState === "error"}
						<article class="message is-danger">
							<div class="message-header"><p>Failed to load file</p></div>
							<div class="message-body">{errorMessage}</div>
						</article>
					{:else if fileLoadState === "ready"}
						<div class="box">
							<p class="has-text-weight-semibold is-family-monospace mb-3">{selectedName}</p>
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
		{/if}
	</div>
</section>

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
</style>
