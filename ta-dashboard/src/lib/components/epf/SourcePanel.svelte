<script lang="ts">
	import { onMount } from "svelte";

	import { epfShowWorkspaceFiles, epfAutoRunAfterFetch } from "$lib/epf/settings";
	import { epfSession } from "$lib/epf/session";

	import { GITHUB_PAT_ENV_VAR } from "$epf/util/env-vars.ts";
	import { errorMessage } from "$epf/util/errors.ts";
	import { formatBytes } from "$epf/util/format.ts";
	import type { FetchSourceSummary } from "$epf/hosts/web-host.ts";
	import type { WorkspaceState } from "$epf/platform/web/web-state.ts";

	type Mode = "url" | "fields";

	let mode = $state<Mode>("url");
	let githubUrl = $state("");
	let owner = $state("");
	let repo = $state("");
	let ref = $state("");
	let directory = $state("");
	let message = $state("");
	let lastSummary = $state<FetchSourceSummary | null>(null);
	let dragActive = $state(false);
	let targetDirectory = $state("");
	let fileInput: HTMLInputElement;
	let folderInput: HTMLInputElement;

	const { workspaces, activeWorkspace, files, busy, envValues, configLoaded, writeBlocked, workspaceMissing } = epfSession;
	const tokenSet = $derived(
		$envValues.some((entry) => entry.name === GITHUB_PAT_ENV_VAR && entry.value.length > 0)
	);
	/** Writes are refused while another tab owns browser storage (or in a viewer). */
	const canWrite = $derived($writeBlocked === null);

	onMount(() => {
		githubUrl = "https://github.com/";
	});

	const fetchSource = async (): Promise<void> => {
		if ($busy) {
			return;
		}
		message = "";
		lastSummary = null;
		try {
			const request = mode === "url"
				? { kind: "url" as const, url: githubUrl.trim() }
				: {
					kind: "repo" as const,
					owner: owner.trim(),
					repo: repo.trim(),
					ref: ref.trim().length > 0 ? ref.trim() : undefined,
					directory: directory.trim().length > 0 ? directory.trim() : undefined
				};
			const summary = await epfSession.fetchSource(request);
			lastSummary = summary;
			if (summary === null) {
				return;
			}
			message = `Fetched ${summary.summary.downloaded} file(s) into ${summary.workspace.label}` +
				(summary.summary.tooLarge > 0 ? `, skipped ${summary.summary.tooLarge} over the size cap` : "") +
				(summary.summary.failed > 0 ? `, ${summary.summary.failed} failed` : "") +
				(summary.configLoaded !== null
					? `, config: ${summary.configLoaded}`
					: summary.configError !== null
						? ", config could not be loaded"
						: summary.configCandidates.length > 0
							? ", existing config kept"
							: ", no config found");
			if ($epfAutoRunAfterFetch && $configLoaded && summary.configError === null) {
				await epfSession.run();
			}
		} catch (err) {
			message = errorMessage(err);
		}
	};

	const createEmptyWorkspace = async (): Promise<void> => {
		if ($busy) {
			return;
		}
		const label = prompt("Workspace name", "workspace");
		if (label === null) {
			return;
		}
		message = "";
		try {
			const workspace = await epfSession.createWorkspace(label.trim().length > 0 ? label.trim() : "workspace", "empty");
			message = `Created workspace '${workspace.label}'.`;
		} catch (err) {
			message = errorMessage(err);
		}
	};

	const uploadFromInput = async (input: HTMLInputElement | undefined): Promise<void> => {
		if (input === undefined || input.files === null || input.files.length === 0) {
			return;
		}
		await uploadFiles(Array.from(input.files));
		input.value = "";
	};

	const uploadFiles = async (files: File[]): Promise<void> => {
		if ($busy) {
			return;
		}
		message = "";
		try {
			const payload = await Promise.all(files.map(async (file) => ({
				name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
				bytes: new Uint8Array(await file.arrayBuffer())
			})));
			// Uploading into an empty session creates the workspace it needs;
			// otherwise the "upload files to create one" empty state is a dead end.
			if ($activeWorkspace === null) {
				await epfSession.createWorkspace("uploads", "upload");
			}
			await epfSession.uploadFiles(payload, targetDirectory.trim());
			message = `Uploaded ${payload.length} file(s) to ${$activeWorkspace?.label ?? "the workspace"}${targetDirectory.trim().length > 0 ? `/${targetDirectory.trim()}` : ""}.`;
		} catch (err) {
			message = errorMessage(err);
		}
	};

	const onDrop = async (event: DragEvent): Promise<void> => {
		event.preventDefault();
		dragActive = false;
		if ($busy) {
			return;
		}
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length > 0) {
			await uploadFiles(files);
		}
	};

	const activate = async (workspace: WorkspaceState): Promise<void> => {
		if ($busy) {
			return;
		}
		try {
			await epfSession.activateWorkspace(workspace.path);
		} catch (err) {
			message = errorMessage(err);
		}
	};

	const remove = async (workspace: WorkspaceState): Promise<void> => {
		if ($busy) {
			return;
		}
		if (!confirm(`Delete workspace '${workspace.label}' and its files?`)) {
			return;
		}
		try {
			await epfSession.removeWorkspace(workspace.path);
		} catch (err) {
			message = errorMessage(err);
		}
	};

	const togglePinned = (workspace: WorkspaceState): void => {
		if ($busy) {
			return;
		}
		epfSession.setWorkspacePinned(workspace.path, !workspace.pinned);
	};
</script>

<div class="columns">
	<div class="column is-6">
		<h3 class="subtitle is-6">GitHub source</h3>

		<div class="buttons has-addons mb-3">
			<button type="button" class={"button is-small" + (mode === "url" ? " is-primary" : "")} onclick={() => (mode = "url")}>
				Paste URL
			</button>
			<button type="button" class={"button is-small" + (mode === "fields" ? " is-primary" : "")} onclick={() => (mode = "fields")}>
				Owner / repo / branch
			</button>
		</div>

		{#if mode === "url"}
			<div class="field">
				<label class="label is-small" for="github-url">Repository, directory or pull request URL</label>
				<input
					id="github-url"
					class="input is-small"
					placeholder="https://github.com/owner/repo/tree/branch/dir"
					bind:value={githubUrl}
				/>
				<p class="help">Tree, blob and pull request URLs are supported; a branch or tag may contain slashes.</p>
			</div>
		{:else}
			<div class="field is-grouped">
				<div class="control is-expanded">
					<label class="label is-small" for="gh-owner">Owner</label>
					<input id="gh-owner" class="input is-small" bind:value={owner} placeholder="owner" />
				</div>
				<div class="control is-expanded">
					<label class="label is-small" for="gh-repo">Repository</label>
					<input id="gh-repo" class="input is-small" bind:value={repo} placeholder="repo" />
				</div>
			</div>
			<div class="field is-grouped">
				<div class="control is-expanded">
					<label class="label is-small" for="gh-ref">Branch / tag / SHA</label>
					<input id="gh-ref" class="input is-small" bind:value={ref} placeholder="main (defaults to the default branch)" />
				</div>
				<div class="control is-expanded">
					<label class="label is-small" for="gh-dir">Directory</label>
					<input id="gh-dir" class="input is-small" bind:value={directory} placeholder="src" />
				</div>
			</div>
		{/if}

		<div class="buttons">
			<button class="button is-small is-primary" onclick={() => void fetchSource()} disabled={$busy || !canWrite}>
				Fetch into a new workspace
			</button>
			<label class="checkbox is-size-7 ml-2" for="auto-run">
				<input id="auto-run" type="checkbox" bind:checked={$epfAutoRunAfterFetch} class="mr-2" />
				Run after fetch
			</label>
		</div>
		<p class="help">
			Token for private repositories: <strong>{tokenSet ? "see the Config tab" : "not set"}</strong>
			(<code>{GITHUB_PAT_ENV_VAR}</code>).
		</p>

		<h3 class="subtitle is-6 mt-5">Manual upload</h3>
		<div class="field">
			<label class="label is-small" for="upload-dir">Upload into (relative to the workspace root)</label>
			<input id="upload-dir" class="input is-small" placeholder="workspace root" bind:value={targetDirectory} />
			<p class="help">
				Folder uploads keep the folder name, so a folder called <code>submission</code> lands in
				<code>submission/…</code>. Set the config's <code>search_directory</code> to match, or upload into a
				subdirectory here.
			</p>
		</div>
		<div
			class={"box has-text-centered " + (dragActive ? "drop-active" : "")}
			role="group"
			aria-label="Upload drop zone"
			ondragover={(event) => {
				event.preventDefault();
				dragActive = true;
			}}
			ondragleave={() => (dragActive = false)}
			ondrop={(event) => void onDrop(event)}
		>
			<p class="is-size-7">Drop files or folders here</p>
			<div class="buttons is-centered mt-2">
				<button class="button is-small" onclick={() => fileInput.click()} disabled={$busy || !canWrite}>Choose files</button>
				<button class="button is-small" onclick={() => folderInput.click()} disabled={$busy || !canWrite}>Choose folder</button>
			</div>
			<input
				bind:this={fileInput}
				type="file"
				multiple
				class="is-hidden"
				onchange={() => void uploadFromInput(fileInput)}
			/>
			<input
				bind:this={folderInput}
				type="file"
				multiple
				class="is-hidden"
				webkitdirectory
				onchange={() => void uploadFromInput(folderInput)}
			/>
			<p class="help">Uploads go into <code>{$activeWorkspace?.label ?? "the active workspace"}</code>.</p>
		</div>
	</div>

	<div class="column is-6">
		<div class="is-flex is-justify-content-space-between is-align-items-center">
			<h3 class="subtitle is-6">Workspaces</h3>
			<button class="button is-small" onclick={() => void createEmptyWorkspace()} disabled={$busy || !canWrite}>New workspace</button>
		</div>
		{#if $workspaces.length === 0}
			<p class="is-size-7 has-text-grey">No workspaces yet. Fetch a repository, upload files, or create an empty workspace.</p>
		{:else}
			<table class="table is-fullwidth is-narrow is-size-7">
				<thead>
					<tr>
						<th>Workspace</th>
						<th>Origin</th>
						<th>Last used</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each $workspaces as workspace (workspace.path)}
						<tr class:is-current={$activeWorkspace?.path === workspace.path}>
							<td>
								<button class="button is-small is-ghost is-fullwidth has-text-left" onclick={() => void activate(workspace)} disabled={$busy}>
									{workspace.label}
									{#if workspace.pinned}
										<span class="tag is-small is-warning ml-2">pinned</span>
									{/if}
								</button>
							</td>
							<td>{workspace.origin}</td>
							<td>{new Date(workspace.lastUsedAt).toLocaleString()}</td>
							<td class="has-text-right">
								<button
									class="button is-small is-light"
									title={workspace.pinned ? "Allow automatic cleanup" : "Protect from cleanup"}
									onclick={() => togglePinned(workspace)}
									disabled={$busy || !canWrite}
								>
									{workspace.pinned ? "Unpin" : "Pin"}
								</button>
								<button class="button is-small is-light ml-1" onclick={() => void remove(workspace)} disabled={$busy || !canWrite}>Delete</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<div class="is-flex is-justify-content-space-between is-align-items-center mt-4">
			<h3 class="subtitle is-6 mb-0">Files in the active workspace</h3>
			<label class="checkbox is-size-7" for="show-files">
				<input id="show-files" type="checkbox" bind:checked={$epfShowWorkspaceFiles} class="mr-2" />
				Show
			</label>
		</div>
		{#if $epfShowWorkspaceFiles}
			{#if $workspaceMissing}
				<article class="message is-warning is-small">
					<div class="message-body">
						<p>
							This workspace's files are not in browser storage yet. They may have been evicted
							by the storage limit, or another tab may have created this workspace without
							saving it yet.
						</p>
						{#if !canWrite}
							<p class="help mt-1">
								This tab is read-only; take over storage (or reload once the other tab is
								closed) to see changes made elsewhere.
							</p>
						{/if}
					</div>
				</article>
			{:else if $files.length === 0}
				<p class="is-size-7 has-text-grey">No files.</p>
			{:else}
				<div class="file-tree">
					<table class="table is-fullwidth is-narrow is-size-7">
						<tbody>
							{#each $files as file (file.path)}
								<tr>
									<td class="is-family-monospace">{file.path}</td>
									<td class="has-text-right">{formatBytes(file.size)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/if}
	</div>
</div>

{#if message.length > 0}
	<article class="message is-info is-small">
		<div class="message-body">{message}</div>
	</article>
{/if}

{#if lastSummary !== null && lastSummary.configError !== null}
	<article class="message is-warning is-small">
		<div class="message-header"><p>The fetched config could not be loaded</p></div>
		<div class="message-body">{lastSummary.configError}</div>
	</article>
{/if}

{#if lastSummary !== null && lastSummary.summary.failed > 0}
	<article class="message is-warning is-small">
		<div class="message-header"><p>Some files failed to download</p></div>
		<div class="message-body">
			<ul>
				{#each lastSummary.summary.outcomes.filter((outcome) => outcome.status === "failed").slice(0, 20) as outcome (outcome.relativePath)}
					<li><code>{outcome.relativePath}</code> — {outcome.status}{outcome.error ? `: ${outcome.error}` : ""}</li>
				{/each}
			</ul>
		</div>
	</article>
{/if}

<style>
	.drop-active {
		border: 2px dashed var(--bulma-link);
		background-color: var(--bulma-link-soft);
	}

	.file-tree {
		max-height: 20rem;
		overflow-y: auto;
	}

	/* Bulma's own `is-selected` row paints the primary colour, so the active
	   workspace gets its own theme-aware highlight instead. */
	tr.is-current td {
		background-color: color-mix(in srgb, var(--bulma-link) 12%, transparent);
		color: var(--bulma-text-strong);
	}
</style>
