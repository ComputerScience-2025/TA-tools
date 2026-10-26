<svelte:head>
	<title>Results Viewer</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";

	import FileBrowser from "$lib/components/FileBrowser.svelte";
	import { epfSession } from "$lib/epf/session";
	import {
		createHashFileSource,
		createHttpApiFileSource,
		createVfsFileSource,
		parseHashFileParams
	} from "$lib/results/file-sources";

	import type { ResultFileSource } from "$lib/results/file-sources";

	type SourceState =
		| { kind: "loading" }
		| { kind: "idle" }
		| { kind: "ready"; source: ResultFileSource }
		| { kind: "error"; message: string };

	let sourceState = $state<SourceState>({ kind: "loading" });
	// Bumped whenever the source changes so the browser component remounts.
	let sourceVersion = $state(0);

	const resolveSource = async (): Promise<void> => {
		const rawHash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
		if (rawHash.trim().length === 0) {
			sourceState = { kind: "idle" };
			return;
		}

		const params = new URLSearchParams(rawHash);
		const apiParam = params.get("api")?.replace(/\/+$/, "") ?? "";
		if (apiParam.length > 0) {
			sourceState = { kind: "ready", source: createHttpApiFileSource(apiParam) };
			sourceVersion += 1;
			return;
		}

		if (params.get("source") === "workspace") {
			sourceState = { kind: "ready", source: createVfsFileSource(epfSession, "browser workspace") };
			sourceVersion += 1;
			return;
		}

		const hashParams = parseHashFileParams(window.location.hash);
		if (hashParams === null) {
			sourceState = { kind: "idle" };
			return;
		}

		try {
			sourceState = { kind: "ready", source: await createHashFileSource(hashParams) };
			sourceVersion += 1;
		} catch (err) {
			sourceState = { kind: "error", message: err instanceof Error ? err.message : "Failed to decode the file from the URL hash." };
		}
	};

	onMount(() => {
		void resolveSource();
		const onHashChange = () => void resolveSource();
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	});
</script>

<section class="section" style="padding: 0">
	<div class="container is-fluid">
		{#if sourceState.kind === "loading"}
			<progress class="progress is-small is-info" max="100"></progress>
		{:else if sourceState.kind === "idle"}
			<article class="message is-warning">
				<div class="message-body">
					<p class="mb-2">Provide a source to get started:</p>
					<ul>
						<li>Live API (CLI in WebUI mode): <code>#api=http://localhost:3000</code></li>
						<li>Browser workspace (EPF page): <code>#source=workspace</code></li>
						<li>Single file: <code>#name=file.md&amp;comp=gzip&amp;data=…</code></li>
					</ul>
				</div>
			</article>
		{:else if sourceState.kind === "error"}
			<article class="message is-danger">
				<div class="message-header">
					<p>Unable to decode file</p>
				</div>
				<div class="message-body">{sourceState.message}</div>
			</article>
		{:else}
			{#key sourceVersion}
				<FileBrowser source={sourceState.source} />
			{/key}
		{/if}
	</div>
</section>
