<svelte:head>
	<title>EPF (browser)</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";

	import { errorMessage } from "$epf/util/errors.ts";
	import { formatBytes } from "$epf/util/format.ts";

	import ConfigPanel from "$lib/components/epf/ConfigPanel.svelte";
	import ConsolePanel from "$lib/components/epf/ConsolePanel.svelte";
	import OutputsPanel from "$lib/components/epf/OutputsPanel.svelte";
	import SourcePanel from "$lib/components/epf/SourcePanel.svelte";
	import { epfSession } from "$lib/epf/session";

	type TabId = "source" | "config" | "console" | "outputs";

	const TABS: { id: TabId; label: string }[] = [
		{ id: "source", label: "Source" },
		{ id: "config", label: "Config" },
		{ id: "console", label: "Console" },
		{ id: "outputs", label: "Outputs" }
	];

	let activeTab = $state<TabId>("source");
	let sessionError = $state<string | null>(null);
	let lockFree = $state(false);
	let takeoverError = $state<string | null>(null);
	let takingOver = $state(false);

	// Destructured so the `$store` syntax applies to plain identifiers.
	const { busy, configLoaded, persistent, initialized, error, usage, consoleEpoch, writeBlocked } = epfSession;

	const usagePercent = $derived(
		$usage !== null && $usage.cap > 0 ? Math.min(100, Math.round(($usage.used / $usage.cap) * 100)) : 0
	);

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
			} catch (err) {
				sessionError = errorMessage(err);
			}
		})();
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
			</div>
		</div>

		{#if $usage !== null}
			<div class="mb-4">
				<div class="is-size-7">
					<span>
						EPF files: {formatBytes($usage.used)} of {formatBytes($usage.cap)}
					</span>
				</div>
				<progress class={"progress is-small " + (usagePercent > 90 ? "is-danger" : usagePercent > 70 ? "is-warning" : "is-info")} value={usagePercent} max="100"></progress>
				<p class="help">
					The logical size of everything EPF keeps in this browser — workspaces, the config library,
					editor drafts and chat sessions — against the limit set in Config → Storage. The browser's
					own whole-site figure is also on that panel; it is not comparable with this number.
					{#if !$persistent}
						This session is memory-only, so nothing here is actually stored.
					{/if}
				</p>
			</div>
		{/if}

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
				<ConfigPanel />
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
