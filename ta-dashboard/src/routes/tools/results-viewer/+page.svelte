<svelte:head>
	<title>Results Viewer</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";
	import { marked } from "marked";

	import { darkMode } from "$lib/stores";

	type FileEntry = { name: string; type: "markdown" | "text" };
	type LoadState = "idle" | "loading" | "ready" | "error";

	let apiBase = $state("");
	let fileList = $state<FileEntry[]>([]);
	let selectedName = $state("");
	let selectedType = $state<"markdown" | "text">("markdown");
	let fileContent = $state("");
	let renderedHtml = $state("");
	let fileLoadState = $state<LoadState>("idle");
	let listLoadState = $state<LoadState>("idle");
	let errorMessage = $state("");
	let isHashSource = $state(false);

	// --- Base64 / gzip helpers ---

	const normalizeBase64 = (input: string): string => {
		const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
		const padding = normalized.length % 4;
		return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
	};

	const base64ToBytes = (input: string): Uint8Array => {
		const normalized = normalizeBase64(input);
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	};

	const decompressIfNeeded = async (bytes: Uint8Array, compValue: string): Promise<string> => {
		if (!compValue || compValue === "none" || compValue === "plain") {
			return new TextDecoder().decode(bytes);
		}
		if (compValue !== "gzip") {
			throw new Error(`Unsupported compression: ${compValue}`);
		}
		if (typeof DecompressionStream === "undefined") {
			throw new Error("This browser does not support gzip decompression.");
		}
		const buffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);
		const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
		return new Response(stream).text();
	};

	// --- Hash source ---

	const SUPPORTED_COMPRESSIONS = new Set(["", "none", "plain", "gzip"]);

	const loadFromHash = async (hash: string): Promise<void> => {
		const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
		const params = new URLSearchParams(rawHash);
		const nameParam = params.get("name")?.trim() ?? "";
		const compParam = params.get("comp")?.trim().toLowerCase() ?? "";
		const dataParam = params.get("data")?.trim() ?? "";

		if (!dataParam) {
			listLoadState = "idle";
			return;
		}

		if (!SUPPORTED_COMPRESSIONS.has(compParam)) {
			listLoadState = "error";
			errorMessage = `Unsupported compression: ${compParam || "(empty)"}`;
			return;
		}

		try {
			listLoadState = "loading";
			const bytes = base64ToBytes(dataParam);
			const text = await decompressIfNeeded(bytes, compParam);
			const name = nameParam || "document.md";
			const type: "markdown" | "text" = name.endsWith(".md") ? "markdown" : "text";

			fileList = [{ name, type }];
			listLoadState = "ready";

			selectedName = name;
			selectedType = type;
			fileContent = text;
			renderedHtml = type === "markdown" ? await marked.parse(text) : "";
			fileLoadState = "ready";
		} catch (err) {
			listLoadState = "error";
			errorMessage = err instanceof Error ? err.message : "Failed to decode hash content.";
		}
	};

	// --- API source ---

	const fetchFileList = async (): Promise<void> => {
		if (!apiBase) {
			return;
		}
		try {
			listLoadState = "loading";
			const res = await fetch(`${apiBase}/`);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = await res.json();
			const newFiles: FileEntry[] = data.files ?? data;
			const prevSelected = selectedName;
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

	const selectFile = async (name: string): Promise<void> => {
		if (!apiBase) {
			return;
		}
		selectedName = name;
		try {
			fileLoadState = "loading";
			const res = await fetch(`${apiBase}/${encodeURIComponent(name)}`);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = await res.json();
			selectedType = data.type ?? "markdown";
			fileContent = data.content ?? "";
			renderedHtml = selectedType === "markdown" ? await marked.parse(fileContent) : "";
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
		const rawHash = window.location.hash.startsWith("#")
			? window.location.hash.slice(1)
			: window.location.hash;
		const hashParams = new URLSearchParams(rawHash);
		const apiParam = hashParams.get("api")?.replace(/\/+$/, "") ?? "";

		if (apiParam) {
			apiBase = apiParam;
			void fetchFileList();
			refreshInterval = setInterval(() => void fetchFileList(), 3000);
			return () => {
				if (refreshInterval) {
					clearInterval(refreshInterval);
				}
			};
		}

		if (window.location.hash) {
			isHashSource = true;
			void loadFromHash(window.location.hash);
			const onHashChange = () => void loadFromHash(window.location.hash);
			window.addEventListener("hashchange", onHashChange);
			return () => window.removeEventListener("hashchange", onHashChange);
		}

		listLoadState = "idle";
	});
</script>

<section class="section" style="padding: 0">
	<div class="container is-fluid">
		<div class="is-flex is-justify-content-space-between is-align-items-center mb-4">
			<div>
				<p class="subtitle mb-0">
					{#if apiBase}
						Viewing outputs from <code>{apiBase}</code>
					{:else if isHashSource}
						Viewing file from URL hash
					{:else}
						Results Viewer
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

		{#if !apiBase && !isHashSource}
			<article class="message is-warning">
				<div class="message-body">
					<p class="mb-2">Provide a source to get started:</p>
					<ul>
						<li>Live API: <code>#api=http://localhost:3000</code></li>
						<li>Hash file: <code>#name=file.md&amp;comp=gzip&amp;data=…</code></li>
					</ul>
				</div>
			</article>
		{/if}
		{#if listLoadState === "error"}
			<article class="message is-danger">
				<div class="message-header">
					<p>{apiBase ? "Unable to connect to API" : "Unable to decode file"}</p>
				</div>
				<div class="message-body">{errorMessage}</div>
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
										class="button is-text is-fullwidth has-text-left menu-item-btn"
										class:is-active={selectedName === file.name}
										onclick={() => void selectFile(file.name)}
										disabled={isHashSource}
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

				<div class="column is-10">
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
		{:else}
			<p>No Files</p>
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
