<svelte:head>
	<title>EPF (browser)</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";

	import { CONFIG_URL_ENV_VAR } from "$epf/util/env-vars.ts";
	import { errorMessage } from "$epf/util/errors.ts";

	import ConfigPanel from "$lib/components/epf/ConfigPanel.svelte";
	import ConsolePanel from "$lib/components/epf/ConsolePanel.svelte";
	import OutputsPanel from "$lib/components/epf/OutputsPanel.svelte";
	import SourcePanel from "$lib/components/epf/SourcePanel.svelte";
	import type { ConfigSection } from "$lib/epf/config-sections.ts";
	import { epfSession } from "$lib/epf/session";

	type TabId = "source" | "config" | "console" | "outputs";

	const TABS: { id: TabId; label: string }[] = [
		{ id: "source", label: "Source" },
		{ id: "config", label: "Config" },
		{ id: "console", label: "Console" },
		{ id: "outputs", label: "Outputs" }
	];

	let activeTab = $state<TabId>("source");
	let configSection = $state<ConfigSection>("editor");
	let sessionError = $state<string | null>(null);
	let lockFree = $state(false);
	let takeoverError = $state<string | null>(null);
	let takingOver = $state(false);
	/** Config URL offered by the page hash, awaiting the user's confirmation. */
	let pendingSharedUrl = $state<string | null>(null);
	let sharedConfigError = $state<string | null>(null);
	let loadingSharedConfig = $state(false);

	// Destructured so the `$store` syntax applies to plain identifiers.
	const { busy, configLoaded, persistent, initialized, error, usage, consoleEpoch, writeBlocked } = epfSession;

	const usagePercent = $derived(
		$usage !== null && $usage.cap > 0 ? Math.min(100, Math.round(($usage.used / $usage.cap) * 100)) : 0
	);

	const openStorage = (): void => {
		activeTab = "config";
		configSection = "storage";
	};

	/** Config URL from the hash query, e.g. `#xyz?EPF_CONFIG_URL=https%3A%2F%2F…`. */
	const sharedConfigUrlFromHash = (): string | null => {
		const hash = window.location.hash.replace(/^#/, "");
		const queryStart = hash.indexOf("?");
		if (queryStart < 0) {
			return null;
		}
		const params = new URLSearchParams(hash.slice(queryStart + 1));
		const value = (params.get("EPF_CONFIG_URL") ?? params.get("config") ?? "").trim();
		return /^https?:\/\//.test(value) ? value : null;
	};

	/** Remove the config params, keeping the hash route and any other params. */
	const stripSharedConfigHash = (): void => {
		const hash = window.location.hash.replace(/^#/, "");
		const queryStart = hash.indexOf("?");
		if (queryStart < 0) {
			return;
		}
		const route = hash.slice(0, queryStart);
		const params = new URLSearchParams(hash.slice(queryStart + 1));
		if (!params.has("EPF_CONFIG_URL") && !params.has("config")) {
			return;
		}
		params.delete("EPF_CONFIG_URL");
		params.delete("config");
		const query = params.toString();
		const url = new URL(window.location.href);
		url.hash = query.length > 0 ? `${route}?${query}` : route;
		history.replaceState(null, "", url.toString());
	};

	const syncSharedConfig = (): void => {
		if (loadingSharedConfig) {
			return;
		}
		pendingSharedUrl = sharedConfigUrlFromHash();
		sharedConfigError = null;
	};

	const loadSharedConfig = async (): Promise<void> => {
		if (pendingSharedUrl === null || loadingSharedConfig) {
			return;
		}
		const url = pendingSharedUrl;
		loadingSharedConfig = true;
		sharedConfigError = null;
		try {
			// Saving the URL in the environment variable is the explicit record of
			// the user's choice, even when the config turns out to be invalid.
			epfSession.setEnv(CONFIG_URL_ENV_VAR, url, true);
			await epfSession.loadConfigSource({ kind: "url", url });
			stripSharedConfigHash();
			pendingSharedUrl = null;
		} catch (err) {
			sharedConfigError = errorMessage(err);
		} finally {
			loadingSharedConfig = false;
		}
	};

	const dismissSharedConfig = (): void => {
		if (loadingSharedConfig) {
			return;
		}
		stripSharedConfigHash();
		pendingSharedUrl = null;
		sharedConfigError = null;
	};

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
			} catch (err) {
				sessionError = errorMessage(err);
			}
		})();
		syncSharedConfig();
		window.addEventListener("hashchange", syncSharedConfig);
		return () => window.removeEventListener("hashchange", syncSharedConfig);
	});

	// A URL config can change between runs, so the Config tab re-fetches it on
	// open. Only an initialised session has an engine to refresh against.
	$effect(() => {
		if (activeTab !== "config" || !$initialized) {
			return;
		}
		void epfSession.refreshRemoteConfig().catch((err) => {
			sessionError = errorMessage(err);
		});
	});

	// While another tab owns storage, watch for the lock being released so the
	// takeover button can appear without a page reload.
	$effect(() => {
		if ($writeBlocked !== "another-tab") {
			lockFree = false;
			return;
		}
		let active = true;
		const poll = async (): Promise<void> => {
			const free = await epfSession.canTakeOverStorage();
			if (active) {
				lockFree = free;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 2000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	});

	const takeOver = async (): Promise<void> => {
		if (takingOver) {
			return;
		}
		takingOver = true;
		takeoverError = null;
		try {
			await epfSession.takeOverStorage();
		} catch (err) {
			takeoverError = errorMessage(err);
		} finally {
			takingOver = false;
		}
	};
</script>

<section class="section" style="padding: 0">
	<div class="container is-fluid">
		<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
			<div>
				<h1 class="title is-4 mb-1">EPF in the browser</h1>
				<p class="is-size-7 has-text-grey">
					Fetch or upload submissions, run analysis workflows and read the results — all client-side.
				</p>
			</div>
			<div class="has-text-right">
				{#if $busy}
					<span class="tag is-info is-light">working…</span>
				{:else if $configLoaded}
					<span class="tag is-success is-light">config loaded</span>
				{:else}
					<span class="tag is-warning is-light">no config</span>
				{/if}
				{#if $writeBlocked !== null}
					<span class="tag is-warning is-light" title="Writes are disabled in this tab; saved files stay readable.">
						read-only
					</span>
				{:else if !$persistent}
					<span class="tag is-warning is-light" title="IndexedDB is unavailable, so nothing is saved between visits.">
						session only
					</span>
				{/if}
				{#if usagePercent > 85}
					<button
						type="button"
						class="button is-small is-warning is-light"
						onclick={openStorage}
						title="EPF's browser storage is nearly full — open the storage settings."
					>
						storage {usagePercent}%
					</button>
				{/if}
			</div>
		</div>

		{#if $writeBlocked !== null}
			<article class="message is-warning">
				<div class="message-header"><p>This tab cannot save to browser storage</p></div>
				<div class="message-body">
					{#if $writeBlocked === "another-tab"}
						<p>
							Another EPF tab owns browser storage. This tab can still read the files that were
							already saved — listing, viewing and downloading all work — but changes are disabled.
						</p>
						<p class="help mt-2">
							Close the other EPF tab, then take over storage here. No page reload is needed.
						</p>
						<div class="buttons mt-3">
							{#if lockFree}
								<button class="button is-small is-primary" onclick={() => void takeOver()} disabled={takingOver || $busy}>
									{takingOver ? "Taking over…" : "Take over storage"}
								</button>
							{:else}
								<button class="button is-small is-light" disabled>Waiting for the other tab to close…</button>
							{/if}
						</div>
						{#if takeoverError !== null}
							<p class="help is-danger mt-2">{takeoverError}</p>
						{/if}
					{:else}
						<p>
							This view is read-only. Open the EPF page to make changes; the saved files stay
							readable here.
						</p>
					{/if}
				</div>
			</article>
		{/if}

		{#if sessionError !== null}
			<article class="message is-danger">
				<div class="message-header"><p>The EPF session could not start</p></div>
				<div class="message-body">{sessionError}</div>
			</article>
		{/if}

		{#if $error !== null}
			<article class="message is-danger is-small">
				<div class="message-body">{$error}</div>
			</article>
		{/if}

		{#if pendingSharedUrl !== null}
			<article class="message is-info">
				<div class="message-header"><p>Config from this link</p></div>
				<div class="message-body">
					<p class="mb-2">This link wants to load a config from:</p>
					<p class="mb-2"><code style="word-break: break-all">{pendingSharedUrl}</code></p>
					<p class="help">
						Only load it if you trust the source. A config can contain API keys and provider
						settings, and its workflows will use them.
					</p>
					{#if sharedConfigError !== null}
						<p class="help is-danger mt-2">{sharedConfigError}</p>
					{/if}
					<div class="buttons mt-3">
						<button
							type="button"
							class="button is-small is-primary"
							onclick={() => void loadSharedConfig()}
							disabled={loadingSharedConfig || $busy || !$initialized}
						>
							{loadingSharedConfig ? "Loading…" : "Load config"}
						</button>
						<button
							type="button"
							class="button is-small"
							onclick={dismissSharedConfig}
							disabled={loadingSharedConfig}
						>
							Dismiss
						</button>
					</div>
				</div>
			</article>
		{/if}

		<div class="buttons has-addons mb-4">
			{#each TABS as tab (tab.id)}
				<button
					type="button"
					class={"button is-small" + (activeTab === tab.id ? " is-primary" : "")}
					onclick={() => (activeTab = tab.id)}
				>
					{tab.label}
				</button>
			{/each}
		</div>

		{#if !$initialized}
			<progress class="progress is-small is-info" max="100"></progress>
		{:else}
			<!-- Keep the forms mounted so switching tabs does not discard drafts. -->
			<div hidden={activeTab !== "source"}>
				<SourcePanel />
			</div>
			<div hidden={activeTab !== "config"}>
				<ConfigPanel bind:section={configSection} />
			</div>
			{#if activeTab === "console"}
				{#key $consoleEpoch}
					<ConsolePanel />
				{/key}
			{/if}
			<div hidden={activeTab !== "outputs"}>
				<OutputsPanel />
			</div>
		{/if}
	</div>
</section>
