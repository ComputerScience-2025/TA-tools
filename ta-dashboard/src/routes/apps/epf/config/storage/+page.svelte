<script lang="ts">
	import { onMount } from "svelte";

	import { errorMessage } from "$epf/util/errors.ts";
	import { formatBytes } from "$epf/util/format.ts";

	import { configEditor } from "$lib/epf/config-editor.svelte.ts";
	import { configHref } from "$lib/epf/routes.ts";
	import { epfSession } from "$lib/epf/session";

	/** Friendly names for `navigator.storage.estimate().usageDetails` keys. */
	const USAGE_DETAIL_LABELS: Record<string, string> = {
		indexedDB: "IndexedDB",
		caches: "Cache storage",
		serviceWorkerRegistrations: "Service workers",
		fileSystem: "File system"
	};

	const usageDetailLabel = (name: string): string => USAGE_DETAIL_LABELS[name] ?? name;

	let message = $state("");
	let actionIssues = $state<string[]>([]);
	let storageMaxMb = $state(0);
	let storageFileMb = $state(0);
	let storageTtlDays = $state(0);
	let estimating = $state(false);
	let estimateError = $state("");

	const { busy, usage, browserEstimate, persistent, writeBlocked, homeConfigs } = epfSession;
	const canWrite = $derived($writeBlocked === null);
	const usagePercent = $derived(
		$usage !== null && $usage.cap > 0 ? Math.min(100, Math.round(($usage.used / $usage.cap) * 100)) : 0
	);
	const browserDetails = $derived(
		Object.entries($browserEstimate?.details ?? {}).map(([name, bytes]) => ({
			name: usageDetailLabel(name),
			bytes
		}))
	);

	const resetFeedback = (): void => {
		message = "";
		actionIssues = [];
	};

	const fail = (err: unknown): void => {
		const text = errorMessage(err);
		message = text;
		actionIssues = text.split("\n");
	};

	const syncStorageFromSession = (): void => {
		const settings = epfSession.getStorageSettings();
		if (settings === null) {
			return;
		}
		storageMaxMb = Math.round(settings.maxTotalBytes / (1024 * 1024));
		storageFileMb = Math.round(settings.maxFileBytes / (1024 * 1024));
		storageTtlDays = settings.sourceTtlDays;
	};

	const refreshEstimate = async (): Promise<void> => {
		if (estimating) {
			return;
		}
		estimating = true;
		estimateError = "";
		try {
			await epfSession.refreshBrowserEstimate();
		} catch (err) {
			estimateError = errorMessage(err);
		} finally {
			estimating = false;
		}
	};

	const applyStorageSettings = async (): Promise<void> => {
		const totalMb = Number(storageMaxMb);
		const fileMb = Number(storageFileMb);
		const ttlDays = Number(storageTtlDays);
		if (![totalMb, fileMb, ttlDays].every((value) => Number.isFinite(value) && value >= 1)) {
			actionIssues = ["Total, per-file and TTL values must be finite numbers of at least 1."];
			message = "Storage limits were not changed.";
			return;
		}
		resetFeedback();
		try {
			await epfSession.setStorageSettings({
				maxTotalBytes: Math.round(totalMb) * 1024 * 1024,
				maxFileBytes: Math.round(fileMb) * 1024 * 1024,
				sourceTtlDays: Math.round(ttlDays)
			});
			syncStorageFromSession();
			message = "Storage limits updated.";
		} catch (err) {
			fail(err);
		}
	};

	const clearDrafts = async (): Promise<void> => {
		if (!confirm("Clear all unsaved editor drafts?")) {
			return;
		}
		resetFeedback();
		try {
			await epfSession.clearEditorDrafts();
			configEditor.draftNotice = null;
			message = "Editor drafts cleared. An open dirty editor will save its draft again on the next change.";
		} catch (err) {
			fail(err);
		}
	};

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
			} catch (err) {
				fail(err);
				return;
			}
			syncStorageFromSession();
			// The estimate is origin-wide and approximate, so it is read when this
			// section is opened and on demand — never after routine writes.
			await refreshEstimate();
		})();
	});
</script>

{#if $usage !== null}
	<div class="mb-5">
		<div class="is-flex is-justify-content-space-between is-align-items-baseline">
			<p class="is-size-7">
				EPF files: <strong>{formatBytes($usage.used)}</strong> of {formatBytes($usage.cap)}
			</p>
			<span class="tag is-small">{usagePercent}%</span>
		</div>
		<progress
			class={"progress is-small " + (usagePercent > 90 ? "is-danger" : usagePercent > 70 ? "is-warning" : "is-info")}
			value={usagePercent}
			max="100"
			aria-label="EPF storage used"
		></progress>
		<p class="help">
			Logical size of the workspaces, config library, editor drafts and chat sessions, against the limit
			below.
		</p>
	</div>
{/if}

<div class="columns">
	<div class="column is-7">
		<h3 class="subtitle is-6">Browser storage limits</h3>
		<div class="field is-grouped">
			<div class="control">
				<label class="label is-small" for="storage-total">Total (MB)</label>
				<input id="storage-total" class="input is-small" type="number" min="1" bind:value={storageMaxMb} />
			</div>
			<div class="control">
				<label class="label is-small" for="storage-file">Per file (MB)</label>
				<input id="storage-file" class="input is-small" type="number" min="1" bind:value={storageFileMb} />
			</div>
			<div class="control">
				<label class="label is-small" for="storage-ttl">Source TTL (days)</label>
				<input id="storage-ttl" class="input is-small" type="number" min="1" bind:value={storageTtlDays} />
			</div>
		</div>
		<button class="button is-small" onclick={() => void applyStorageSettings()} disabled={$busy || !canWrite}>Apply limits</button>
		<p class="help mt-2">
			When the total is exceeded, the least recently used unpinned workspace is deleted first. Pinned workspaces,
			the active one and the config library are never removed automatically.
		</p>
	</div>
	<div class="column is-5">
		<h3 class="subtitle is-6">Config library</h3>
		<p class="is-size-7">
			{$homeConfigs.length} file{$homeConfigs.length === 1 ? "" : "s"} in the durable library, outside the
			temporary workspace area.
		</p>
		<div class="buttons mt-3">
			<a class="button is-small" href={configHref("library")}>Open library</a>
			<button type="button" class="button is-small is-danger is-light" onclick={() => void clearDrafts()} disabled={$busy || !canWrite}>Clear editor drafts</button>
		</div>
	</div>
</div>

<h3 class="subtitle is-6 mt-5">Browser estimate</h3>
{#if !$persistent}
	<p class="is-size-7 mt-2">
		IndexedDB is unavailable in this browser context, so this session is memory-only: EPF files are not stored
		between visits and the browser has nothing to report.
	</p>
{:else if $browserEstimate === null}
	<p class="is-size-7 mt-2 has-text-grey">This browser does not report a site-wide storage estimate.</p>
{:else}
	<div class="is-flex is-justify-content-space-between is-align-items-baseline mt-2">
		<p class="is-size-7">
			Browser estimate (whole site, on disk): <strong>{formatBytes($browserEstimate.usage)}</strong> of about
			{formatBytes($browserEstimate.quota)} available
		</p>
		<button
			type="button"
			class="button is-small is-light"
			onclick={() => void refreshEstimate()}
			disabled={estimating || $busy}
		>
			{estimating ? "Reading…" : "Refresh"}
		</button>
	</div>
	{#if browserDetails.length > 0}
		<ul class="is-size-7 has-text-grey">
			{#each browserDetails as detail (detail.name)}
				<li>{detail.name}: {formatBytes(detail.bytes)}</li>
			{/each}
		</ul>
	{/if}
	<p class="help">
		This is not the size of EPF's files. The browser compresses stored data, so its figure can be much smaller
		than the logical total; and it appends a copy on every write instead of overwriting in place, so saving even
		a few bytes can add tens of kilobytes until the database is compacted. Read it as a rough idea of the room
		the site has left, not as a measurement of the config or the workspace.
	</p>
{/if}
{#if estimateError.length > 0}
	<p class="help is-danger">{estimateError}</p>
{/if}

{#if message.length > 0}
	<article class="message is-small {actionIssues.length > 0 ? "is-danger" : "is-info"}">
		<div class="message-body">
			<p>{message}</p>
			{#if actionIssues.length > 0}
				<ul class="mt-2">
					{#each actionIssues as issue, index (index)}
						<li><code>{issue}</code></li>
					{/each}
				</ul>
			{/if}
		</div>
	</article>
{/if}
