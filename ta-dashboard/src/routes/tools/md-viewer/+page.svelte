<svelte:head>
	<title>Markdown Viewer</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";
	import { marked } from "marked";
	import { darkMode } from "$lib/stores";
	import { get } from "svelte/store";

	import "$lib/dark-theme.css";

	let isDark = $state(get(darkMode));

	$effect(() => {
		darkMode.set(isDark);
	});

	type LoadState = "idle" | "ready" | "error";

	let fileName = $state("document.md");
	let comp = $state("");
	let markdown = $state("");
	let renderedHtml = $state("");
	let loadState = $state<LoadState>("idle");
	let errorMessage = $state("");
	let dataSize = $state(0);

	const supportedCompressions = new Set(["", "none", "plain", "gzip"]);

	const normalizeBase64 = (input: string) => {
		const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
		const padding = normalized.length % 4;
		return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
	};

	const base64ToBytes = (input: string) => {
		const normalized = normalizeBase64(input);
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	};

	const decompressIfNeeded = async (bytes: Uint8Array, compValue: string) => {
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

	const loadFromHash = async (hash: string) => {
		const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
		const params = new URLSearchParams(rawHash);
		const nameParam = params.get("name")?.trim() ?? "";
		const compParam = params.get("comp")?.trim().toLowerCase() ?? "";
		const dataParam = params.get("data")?.trim() ?? "";

		fileName = nameParam || "document.md";
		comp = compParam;
		dataSize = dataParam.length;

		if (!dataParam) {
			loadState = "idle";
			errorMessage = "";
			markdown = "";
			renderedHtml = "";
			return;
		}

		if (!supportedCompressions.has(compParam)) {
			loadState = "error";
			errorMessage = `Unsupported compression: ${compParam || "(empty)"}`;
			markdown = "";
			renderedHtml = "";
			return;
		}

		try {
			loadState = "idle";
			errorMessage = "";
			const bytes = base64ToBytes(dataParam);
			const text = await decompressIfNeeded(bytes, compParam);
			markdown = text;
			renderedHtml = await marked.parse(text);
			loadState = "ready";
		} catch (error) {
			loadState = "error";
			errorMessage = error instanceof Error ? error.message : "Failed to decode markdown.";
			markdown = "";
			renderedHtml = "";
		}
	};

	onMount(() => {
		const applyHash = () => {
			void loadFromHash(window.location.hash);
		};
		applyHash();
		window.addEventListener("hashchange", applyHash);
		return () => window.removeEventListener("hashchange", applyHash);
	});
</script>

<section class="section" data-theme={isDark ? "dark" : "light"}>
	<div class="container">
		<div class="is-flex is-justify-content-space-between is-align-items-center mb-4">
			<div>
				<h1 class="title mb-1">Markdown Viewer</h1>
				<p class="subtitle mb-0">Decode and render a markdown file from the URL hash.</p>
			</div>
			<button
				class="button is-light"
				onclick={() => (isDark = !isDark)}
				title={isDark ? "Switch to light mode" : "Switch to dark mode"}
			>
				{isDark ? "☀️ Light" : "🌙 Dark"}
			</button>
		</div>

		<div class="box">
			<div class="columns is-multiline">
				<div class="column is-6">
					<p class="has-text-weight-semibold">File</p>
					<p class="is-family-monospace">{fileName}</p>
				</div>
				<div class="column is-3">
					<p class="has-text-weight-semibold">Compression</p>
					<p class="is-family-monospace">{comp || "none"}</p>
				</div>
				<div class="column is-3">
					<p class="has-text-weight-semibold">Data length</p>
					<p class="is-family-monospace">{dataSize} chars</p>
				</div>
			</div>
		</div>

		{#if loadState === "error"}
			<article class="message is-danger">
				<div class="message-header">
					<p>Unable to load markdown</p>
				</div>
				<div class="message-body">
					{errorMessage}
				</div>
			</article>
		{/if}

		{#if loadState === "idle" && !markdown}
			<article class="message is-warning">
				<div class="message-body">
					Provide a URL hash like
					<code>#{"name=README.md&comp=gzip&data=..."}</code>
					to view the decoded markdown.
				</div>
			</article>
		{/if}

		{#if loadState === "ready"}
			<div class="content">
				{@html renderedHtml}
			</div>
		{/if}
	</div>
</section>

