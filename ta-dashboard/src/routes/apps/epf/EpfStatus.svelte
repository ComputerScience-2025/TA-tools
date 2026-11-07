<script lang="ts">
	import { errorMessage } from "$epf/util/errors.ts";

	import { configHref } from "$lib/epf/routes.ts";
	import { epfSession } from "$lib/epf/session";

	interface Props {
		/** Set by the layout when the session could not start. */
		sessionError: string | null;
	}

	let { sessionError }: Props = $props();

	const { busy, configLoaded, persistent, error, usage, writeBlocked } = epfSession;

	let lockFree = $state(false);
	let takeoverError = $state<string | null>(null);
	let takingOver = $state(false);

	const storageHref = configHref("storage");
	const usagePercent = $derived(
		$usage !== null && $usage.cap > 0 ? Math.min(100, Math.round(($usage.used / $usage.cap) * 100)) : 0
	);

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
			<a
				class="button is-small is-warning is-light"
				href={storageHref}
				title="EPF's browser storage is nearly full — open the storage settings."
			>
				storage {usagePercent}%
			</a>
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
