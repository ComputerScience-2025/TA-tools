<svelte:head>
	<title>EPF — Config</title>
</svelte:head>

<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";

	import { CURRENT_CONFIG_VERSION } from "$epf/util/config-schema.ts";
	import { errorMessage } from "$epf/util/errors.ts";

	import RouteBoundary from "../RouteBoundary.svelte";
	import { configEditor } from "$lib/epf/config-editor.svelte.ts";
	import { sourceDisplayLabel } from "$lib/epf/config-model.ts";
	import { CONFIG_TABS, configTabForPath } from "$lib/epf/routes.ts";
	import { epfSession } from "$lib/epf/session";

	import type { Snippet } from "svelte";

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	const { busy, remoteConfig, activeWorkspace, configSource, attemptedConfigSource, configText } = epfSession;
	let remoteError = $state<string | null>(null);
	let draftError = $state<string | null>(null);

	const activeTab = $derived(configTabForPath(page.url.pathname));
	const sourceLabel = $derived(
		sourceDisplayLabel(configEditor.source, epfSession.getHomeDir(), $activeWorkspace?.path ?? null)
	);

	const refreshRemote = async (): Promise<void> => {
		remoteError = null;
		try {
			await epfSession.refreshRemoteConfig();
		} catch (err) {
			remoteError = errorMessage(err);
		}
	};

	const openEditor = async (): Promise<void> => {
		// Register the draft flush listeners for the page session and give the
		// header/library a document to describe, whichever Config route is
		// reached. `openActive` never replaces an in-memory document.
		configEditor.start();
		await configEditor.openActive($configSource ?? $attemptedConfigSource, $configText);
	};

	// The layout is created when the Config tab is entered, so this is the
	// "opening the Config tab" refresh. Moving between sections keeps the
	// layout mounted and does not re-fetch.
	onMount(() => {
		void Promise.all([openEditor(), refreshRemote()]);
	});

	// Reconcile each source's saved draft once, whichever Config route opened
	// it. The Library route opens documents while the Editor page is unmounted,
	// so the check cannot live on that page alone.
	$effect(() => {
		const key = configEditor.sourceKey;
		if (!configEditor.hasDocument || key === "new") {
			return;
		}
		void configEditor.reconcileDraft().then((error) => {
			if (error !== null) {
				draftError = error;
			}
		});
	});
</script>

<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
	<div>
		<h3 class="subtitle is-6 mb-1">Configuration</h3>
		<p class="is-size-7 has-text-grey">
			Edit the whole <code>epf.toml</code> without typing TOML. Drafts and library files are stored in this browser,
			including API keys.
		</p>
	</div>
	<div class="has-text-right">
		{#if configEditor.hasDocument}
			<span class="tag is-small is-light">{sourceLabel}</span>
			{#if configEditor.pendingMigration !== null}
				<span class="tag is-small is-warning is-light">needs migration</span>
			{:else}
				{#if configEditor.dirty || configEditor.source === null || configEditor.source.kind === "inline"}
					<span class="tag is-small is-warning is-light">unsaved</span>
				{:else}
					<span class="tag is-small is-success is-light">saved</span>
				{/if}
				{#if configEditor.readOnly}
					<span class="tag is-small is-info is-light">read-only</span>
				{/if}
			{/if}
		{/if}
		{#if configEditor.pendingMigration !== null}
			<span class="tag is-small">v{configEditor.pendingMigration.fromVersion} → v{CURRENT_CONFIG_VERSION}</span>
		{:else if configEditor.hasDocument}
			<span class="tag is-small">v{configEditor.documentVersion ?? configEditor.configVersion}</span>
		{:else}
			<span class="tag is-small">no document</span>
		{/if}
	</div>
</div>

{#if $remoteConfig !== null}
	<article class={"message is-small " + ($remoteConfig.error === null ? "is-info" : "is-warning")}>
		<div class="message-body">
			<div class="is-flex is-justify-content-space-between is-align-items-center">
				<p>
					Remote config · last fetched {$remoteConfig.fetchedAt === null ? "never" : new Date($remoteConfig.fetchedAt).toLocaleString()}{#if $remoteConfig.changedAt !== null} · changed {new Date($remoteConfig.changedAt).toLocaleTimeString()}{/if}
				</p>
				<button
					type="button"
					class="button is-small is-light"
					onclick={() => void refreshRemote()}
					disabled={$busy}
				>
					Refresh
				</button>
			</div>
			{#if $remoteConfig.error !== null}
				<p class="help">
					Using the last loaded config — refresh failed: {$remoteConfig.error}. Runs still use the last
					successfully loaded config.
				</p>
			{:else}
				<p class="help">Fetched fresh before each run.</p>
			{/if}
			{#if remoteError !== null}
				<p class="help is-danger mt-2">{remoteError}</p>
			{/if}
		</div>
	</article>
{/if}

{#if configEditor.openError !== null}
	<article class="message is-danger is-small">
		<div class="message-body">{configEditor.openError}</div>
	</article>
{/if}

{#if draftError !== null}
	<article class="message is-warning is-small">
		<div class="message-body">{draftError}</div>
	</article>
{/if}

<nav class="buttons has-addons mb-4" aria-label="Config sections">
	{#each CONFIG_TABS as tab (tab.id)}
		<a
			class={"button is-small" + (activeTab === tab.id ? " is-primary" : "")}
			href={tab.href}
			aria-current={activeTab === tab.id ? "page" : undefined}
		>
			{tab.label}
		</a>
	{/each}
</nav>

{#key page.url.pathname}
	<RouteBoundary label="This config section could not be shown">
		{@render children()}
	</RouteBoundary>
{/key}
