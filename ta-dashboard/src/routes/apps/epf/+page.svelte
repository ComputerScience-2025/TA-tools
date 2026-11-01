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

	// Destructured so the `$store` syntax applies to plain identifiers.
	const { busy, configLoaded, persistent, soleOwner, initialized, error, usage, consoleEpoch } = epfSession;

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
				{#if !$soleOwner}
					<span class="tag is-warning is-light" title="Another tab owns browser storage; this tab will not persist.">
						another tab owns storage
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
				<div class="is-flex is-justify-content-space-between is-size-7">
					<span>Browser storage: {formatBytes($usage.used)} of {formatBytes($usage.cap)}</span>
					{#if $usage.browserQuota !== null}
						<span class="has-text-grey">Browser quota: {formatBytes($usage.browserUsage ?? 0)} / {formatBytes($usage.browserQuota)}</span>
					{/if}
				</div>
				<progress class={"progress is-small " + (usagePercent > 90 ? "is-danger" : usagePercent > 70 ? "is-warning" : "is-info")} value={usagePercent} max="100"></progress>
			</div>
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
