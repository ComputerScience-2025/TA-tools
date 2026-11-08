<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";

	import { CONFIG_URL_ENV_VAR } from "$epf/util/env-vars.ts";
	import { errorMessage } from "$epf/util/errors.ts";

	import EpfStatus from "./EpfStatus.svelte";
	import RouteBoundary from "./RouteBoundary.svelte";
	import SharedConfigPrompt from "./SharedConfigPrompt.svelte";
	import { EPF_TABS, epfTabForPath } from "$lib/epf/routes.ts";
	import { epfSession } from "$lib/epf/session";
	import { sharedConfigUrlFromHash, stripSharedConfigHash } from "$lib/epf/shared-config.ts";

	import type { Snippet } from "svelte";

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	let sessionError = $state<string | null>(null);
	/** Config URL offered by the page hash, awaiting the user's confirmation. */
	let pendingSharedUrl = $state<string | null>(null);
	let sharedConfigError = $state<string | null>(null);
	let loadingSharedConfig = $state(false);

	const { busy, initialized } = epfSession;

	const activeTab = $derived(epfTabForPath(page.url.pathname));

	const syncSharedConfig = (): void => {
		if (loadingSharedConfig) {
			return;
		}
		pendingSharedUrl = sharedConfigUrlFromHash(window.location.hash);
		sharedConfigError = null;
	};

	/** Remove the config params, keeping the hash route and any other params. */
	const stripSharedConfig = (): void => {
		const next = stripSharedConfigHash(window.location.hash);
		if (next === null) {
			return;
		}
		const url = new URL(window.location.href);
		url.hash = next;
		// Hash-only update: keep SvelteKit's history entry intact.
		history.replaceState(history.state, "", url.toString());
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
			epfSession.setEnv(CONFIG_URL_ENV_VAR, url);
			await epfSession.loadConfigSource({ kind: "url", url });
			stripSharedConfig();
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
		stripSharedConfig();
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
</script>

<section class="section" style="padding: 0">
	<div class="container is-fluid">
		<EpfStatus {sessionError} />

		{#if pendingSharedUrl !== null}
			<SharedConfigPrompt
				url={pendingSharedUrl}
				error={sharedConfigError}
				loading={loadingSharedConfig}
				disabled={$busy || !$initialized}
				onLoad={() => void loadSharedConfig()}
				onDismiss={dismissSharedConfig}
			/>
		{/if}

		<nav class="buttons has-addons mb-4" aria-label="EPF sections">
			{#each EPF_TABS as tab (tab.id)}
				<a
					class={"button is-small" + (activeTab === tab.id ? " is-primary" : "")}
					href={tab.href}
					aria-current={activeTab === tab.id ? "page" : undefined}
				>
					{tab.label}
				</a>
			{/each}
		</nav>

		{#if !$initialized}
			<progress class="progress is-small is-info" max="100"></progress>
		{:else}
			<!-- Keyed by tab so a config sub-route change keeps the Config layout
			     (and its remote-config refresh) mounted. -->
			{#key activeTab ?? page.url.pathname}
				<RouteBoundary>
					{@render children()}
				</RouteBoundary>
			{/key}
		{/if}
	</div>
</section>
