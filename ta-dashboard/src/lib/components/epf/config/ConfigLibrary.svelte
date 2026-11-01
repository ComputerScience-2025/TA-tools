<script lang="ts">
	import { onMount } from "svelte";

	import { basenamePath, joinPath } from "$epf/platform/path.ts";
	import { toConfigSource } from "$epf/util/config-loader.ts";

	import { configEditor } from "$lib/epf/config-editor.svelte.ts";
	import { downloadTextFile, formatBytes, readTextFile } from "$lib/epf/config-model.ts";
	import { epfSession } from "$lib/epf/session.ts";

	interface Props {
		onEdit: () => void;
	}

	let { onEdit }: Props = $props();

	let message = $state("");
	let error = $state("");
	let sourceInput = $state("");
	let renaming = $state<string | null>(null);
	let renameValue = $state("");
	let workspaceRenaming = $state<string | null>(null);
	let workspaceRenameValue = $state("");
	let workspaceConfigs = $state<string[]>([]);
	let lastWorkspace = "";
	let fileInput: HTMLInputElement;

	const { homeConfigs, defaultHomeConfig, activeWorkspace, busy } = epfSession;

	const homeDir = (): string => epfSession.getHomeDir();

	const loadedPath = $derived(configEditor.source?.kind === "path" ? configEditor.source.path : null);

	const resetFeedback = (): void => {
		message = "";
		error = "";
	};

	const fail = (err: unknown): void => {
		error = err instanceof Error ? err.message : String(err);
	};

	const refreshWorkspaceConfigs = async (): Promise<void> => {
		try {
			workspaceConfigs = await epfSession.listWorkspaceConfigFiles();
		} catch {
			workspaceConfigs = [];
		}
	};

	const canReplaceEditor = (): boolean =>
		!configEditor.dirty || confirm("Discard the unsaved changes in the editor and open another config?");

	const openDocument = async (source: Parameters<typeof epfSession.openConfigDocument>[0]): Promise<void> => {
		if (!canReplaceEditor()) {
			return;
		}
		resetFeedback();
		if (configEditor.dirty) {
			await configEditor.clearDraft();
		}
		try {
			const document = await epfSession.openConfigDocument(source);
			configEditor.openDocument(document);
			onEdit();
		} catch (err) {
			fail(err);
			if (configEditor.dirty) {
				configEditor.scheduleAutosave();
			}
		}
	};

	const openLibrary = async (name: string): Promise<void> => {
		await openDocument({ kind: "path", path: joinPath(homeDir(), name) });
	};

	const openWorkspaceFile = async (name: string): Promise<void> => {
		const workspace = $activeWorkspace;
		if (workspace === null) {
			return;
		}
		await openDocument({ kind: "path", path: joinPath(workspace.path, name) });
	};

	const openSource = async (): Promise<void> => {
		const value = sourceInput.trim();
		if (value.length === 0) {
			return;
		}
		await openDocument(toConfigSource(value));
	};

	const importFile = async (input: HTMLInputElement | undefined): Promise<void> => {
		if (input === undefined) {
			return;
		}
		if (input.files === null || input.files.length === 0) {
			input.value = "";
			return;
		}
		if (!canReplaceEditor()) {
			input.value = "";
			return;
		}
		resetFeedback();
		const file = input.files[0]!;
		if (configEditor.dirty) {
			await configEditor.clearDraft();
		}
		try {
			const text = await readTextFile(file);
			configEditor.openImported(text, file.name);
			message = `Imported ${file.name}. Review it and choose where to save it.`;
			onEdit();
		} catch (err) {
			fail(err);
			if (configEditor.dirty) {
				configEditor.scheduleAutosave();
			}
		} finally {
			input.value = "";
		}
	};

	const newConfig = async (): Promise<void> => {
		resetFeedback();
		if (configEditor.dirty && !confirm("Discard the unsaved changes in the editor?")) {
			return;
		}
		if (configEditor.dirty) {
			await configEditor.clearDraft();
		}
		try {
			await epfSession.deleteEditorDraft("new");
		} catch {
			// Starting a new document must not be blocked by draft cleanup.
		}
		configEditor.newDocument();
		onEdit();
	};

	const setDefault = async (name: string): Promise<void> => {
		resetFeedback();
		const wasDefault = $defaultHomeConfig === name;
		try {
			await epfSession.setDefaultHomeConfig(wasDefault ? null : name);
			message = wasDefault ? "Library default cleared." : `"${name}" is now the library default.`;
		} catch (err) {
			fail(err);
		}
	};

	const startRename = (name: string): void => {
		resetFeedback();
		if (configEditor.dirty && loadedPath === joinPath(homeDir(), name)) {
			error = "Save or discard your editor changes before renaming the open file.";
			return;
		}
		renaming = name;
		renameValue = name;
	};

	const commitRename = async (name: string): Promise<void> => {
		if (renaming === null) {
			return;
		}
		const target = renameValue.trim();
		if (target.length === 0 || target === name) {
			renaming = null;
			return;
		}
		const oldPath = joinPath(homeDir(), name);
		if (configEditor.dirty && loadedPath === oldPath) {
			error = "Save or discard your editor changes before renaming the open file.";
			return;
		}
		resetFeedback();
		try {
			const source = await epfSession.renameHomeConfig(name, target);
			if (loadedPath === oldPath) {
				configEditor.adoptSource(source, configEditor.sourceText);
			}
			renaming = null;
			message = `Renamed "${name}" to "${basenamePath(source.kind === "path" ? source.path : target)}".`;
		} catch (err) {
			fail(err);
		}
	};

	const duplicate = async (name: string): Promise<void> => {
		resetFeedback();
		try {
			const text = await epfSession.readHomeConfig(name);
			const dot = name.toLowerCase().endsWith(".toml") ? name.length - 5 : name.length;
			const base = `${name.slice(0, dot)}-copy`;
			const existing = new Set($homeConfigs.map((file) => file.name.toLowerCase()));
			let candidate = `${base}.toml`;
			let suffix = 2;
			while (existing.has(candidate.toLowerCase())) {
				candidate = `${base}-${suffix}.toml`;
				suffix += 1;
			}
			await epfSession.saveConfigToHome(text, candidate, { activate: false });
			message = `Duplicated as "${candidate}".`;
		} catch (err) {
			fail(err);
		}
	};

	const remove = async (name: string): Promise<void> => {
		if (!confirm(`Delete "${name}" from the config library?`)) {
			return;
		}
		resetFeedback();
		const path = joinPath(homeDir(), name);
		const wasOpen = loadedPath === path;
		try {
			await epfSession.deleteHomeConfig(name);
			if (wasOpen) {
				configEditor.source = null;
				configEditor.dirty = true;
				configEditor.lastDraftSavedAt = null;
				configEditor.draftNotice = null;
				configEditor.scheduleAutosave();
				message = `Deleted "${name}". The open editor still holds its contents; use Save as to keep them.`;
			} else {
				message = `Deleted "${name}".`;
			}
		} catch (err) {
			fail(err);
		}
	};

	const copyToWorkspace = async (name: string): Promise<void> => {
		const workspace = $activeWorkspace;
		if (workspace === null) {
			error = "There is no active workspace.";
			return;
		}
		if (!confirm(`Copy "${name}" into "${workspace.label}" as epf.toml? An existing epf.toml will be overwritten.`)) {
			return;
		}
		resetFeedback();
		try {
			const source = await epfSession.copyHomeConfigToWorkspace(name, "epf.toml", { overwrite: true });
			if (configEditor.source === null || configEditor.sourceKey === "new") {
				const document = await epfSession.openConfigDocument(source);
				configEditor.openDocument(document);
			}
			message = `Copied "${name}" into the active workspace.`;
			await refreshWorkspaceConfigs();
		} catch (err) {
			fail(err);
		}
	};

	const download = async (name: string): Promise<void> => {
		resetFeedback();
		try {
			const text = await epfSession.readHomeConfig(name);
			downloadTextFile(name, text);
		} catch (err) {
			fail(err);
		}
	};

	const startWorkspaceRename = (name: string): void => {
		resetFeedback();
		const workspace = $activeWorkspace;
		if (workspace !== null && configEditor.dirty && loadedPath === joinPath(workspace.path, name)) {
			error = "Save or discard your editor changes before renaming the open file.";
			return;
		}
		workspaceRenaming = name;
		workspaceRenameValue = basenamePath(name);
	};

	const commitWorkspaceRename = async (name: string): Promise<void> => {
		if (workspaceRenaming === null) {
			return;
		}
		const workspace = $activeWorkspace;
		if (workspace === null) {
			return;
		}
		const target = workspaceRenameValue.trim();
		if (target.length === 0 || target === basenamePath(name)) {
			workspaceRenaming = null;
			return;
		}
		const oldPath = joinPath(workspace.path, name);
		if (configEditor.dirty && loadedPath === oldPath) {
			error = "Save or discard your editor changes before renaming the open file.";
			return;
		}
		resetFeedback();
		try {
			const source = await epfSession.renameWorkspaceConfig(name, target);
			if (loadedPath === oldPath) {
				configEditor.adoptSource(source, configEditor.sourceText);
			}
			workspaceRenaming = null;
			message = `Renamed "${name}".`;
			await refreshWorkspaceConfigs();
		} catch (err) {
			fail(err);
		}
	};

	onMount(() => {
		void refreshWorkspaceConfigs();
	});

	$effect(() => {
		const path = $activeWorkspace?.path ?? "";
		if (path === lastWorkspace) {
			return;
		}
		lastWorkspace = path;
		void refreshWorkspaceConfigs();
	});
</script>

<div class="columns">
	<div class="column is-7">
		<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
			<div>
				<h3 class="subtitle is-6 mb-0">Config library</h3>
				<p class="help">Stored in this browser at <code>{homeDir() || "/epf/home"}</code>. It survives workspace cleanup.</p>
			</div>
			<div class="buttons mb-0">
				<button type="button" class="button is-small is-primary" onclick={() => void newConfig()} disabled={$busy}>New config</button>
				<button type="button" class="button is-small" onclick={() => fileInput.click()} disabled={$busy}>Import .toml</button>
			</div>
		</div>
		<input
			bind:this={fileInput}
			type="file"
			accept=".toml,text/plain"
			class="is-hidden"
			onchange={() => void importFile(fileInput)}
		/>

		{#if $homeConfigs.length === 0}
			<p class="is-size-7 has-text-grey">
				No library configs yet. Save a config here once and new workspaces can use it without a copy.
			</p>
		{:else}
			<table class="table is-fullwidth is-narrow is-size-7">
				<thead>
					<tr>
						<th>File</th>
						<th>Size</th>
						<th>Modified</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each $homeConfigs as file (file.name)}
						{@const isDefault = $defaultHomeConfig === file.name}
						<tr class={loadedPath === joinPath(homeDir(), file.name) ? "is-selected" : ""}>
							<td>
								{#if renaming === file.name}
									<div class="field has-addons mb-0">
										<div class="control">
											<input
												class="input is-small"
												value={renameValue}
												oninput={(event) => (renameValue = event.currentTarget.value)}
												onkeydown={(event) => {
													if (event.key === "Enter") {
														void commitRename(file.name);
													} else if (event.key === "Escape") {
														renaming = null;
													}
												}}
											/>
										</div>
										<div class="control">
											<button type="button" class="button is-small is-primary" onclick={() => void commitRename(file.name)}>Save</button>
										</div>
										<div class="control">
											<button type="button" class="button is-small" onclick={() => (renaming = null)}>Cancel</button>
										</div>
									</div>
								{:else}
									<button type="button" class="button is-small is-ghost has-text-left" onclick={() => void openLibrary(file.name)}>
										{file.name}
									</button>
									{#if isDefault}
										<span class="tag is-small is-success is-light ml-2">default</span>
									{/if}
									{#if loadedPath === joinPath(homeDir(), file.name)}
										<span class="tag is-small is-info is-light ml-2">open</span>
									{/if}
								{/if}
							</td>
							<td>{formatBytes(file.size)}</td>
							<td>{new Date(file.mtimeMs).toLocaleString()}</td>
							<td class="has-text-right">
								<div class="buttons is-right mb-0">
									<button type="button" class="button is-small" onclick={() => void setDefault(file.name)} disabled={$busy}>
										{isDefault ? "Clear default" : "Set default"}
									</button>
									<button type="button" class="button is-small" onclick={() => startRename(file.name)}>Rename</button>
									<button type="button" class="button is-small" onclick={() => void duplicate(file.name)} disabled={$busy}>Duplicate</button>
									<button type="button" class="button is-small" onclick={() => void copyToWorkspace(file.name)} disabled={$busy}>Copy to workspace</button>
									<button type="button" class="button is-small" onclick={() => void download(file.name)}>Download</button>
									<button type="button" class="button is-small is-danger is-light" onclick={() => void remove(file.name)} disabled={$busy}>Delete</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<h3 class="subtitle is-6 mt-5">Open from path or URL</h3>
		<div class="field has-addons">
			<div class="control is-expanded">
				<input
					class="input is-small"
					placeholder="https://…/epf.toml or /epf/workspaces/…/epf.toml"
					bind:value={sourceInput}
					onkeydown={(event) => {
						if (event.key === "Enter") {
							void openSource();
						}
					}}
				/>
			</div>
			<div class="control">
				<button type="button" class="button is-small" onclick={() => void openSource()} disabled={$busy}>Open</button>
			</div>
		</div>
		<p class="help">Opening reads the file for editing; it does not apply it until you press Apply or Save.</p>
	</div>

	<div class="column is-5">
		<h3 class="subtitle is-6">Active workspace configs</h3>
		<p class="help mb-3">
			{#if $activeWorkspace}
				Workspace: <strong>{$activeWorkspace.label}</strong>
			{:else}
				No active workspace.
			{/if}
		</p>
		{#if $activeWorkspace === null}
			<p class="is-size-7 has-text-grey">Create or fetch a workspace in the Source tab.</p>
		{:else if workspaceConfigs.length === 0}
			<p class="is-size-7 has-text-grey">No TOML files in this workspace.</p>
		{:else}
			<table class="table is-fullwidth is-narrow is-size-7">
				<tbody>
					{#each workspaceConfigs as name (name)}
						<tr class={loadedPath === joinPath($activeWorkspace.path, name) ? "is-selected" : ""}>
							<td>
								{#if workspaceRenaming === name}
									<div class="field has-addons mb-0">
										<div class="control">
											<input
												class="input is-small"
												value={workspaceRenameValue}
												oninput={(event) => (workspaceRenameValue = event.currentTarget.value)}
												onkeydown={(event) => {
													if (event.key === "Enter") {
														void commitWorkspaceRename(name);
													} else if (event.key === "Escape") {
														workspaceRenaming = null;
													}
												}}
											/>
										</div>
										<div class="control">
											<button type="button" class="button is-small is-primary" onclick={() => void commitWorkspaceRename(name)}>Save</button>
										</div>
									</div>
								{:else}
									<button type="button" class="button is-small is-ghost has-text-left" onclick={() => void openWorkspaceFile(name)}>
										{name}
									</button>
								{/if}
							</td>
							<td class="has-text-right">
								<button type="button" class="button is-small" onclick={() => startWorkspaceRename(name)}>Rename</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>

{#if message.length > 0}
	<article class="message is-success is-small">
		<div class="message-body">{message}</div>
	</article>
{/if}

{#if error.length > 0}
	<article class="message is-danger is-small">
		<div class="message-body">{error}</div>
	</article>
{/if}
