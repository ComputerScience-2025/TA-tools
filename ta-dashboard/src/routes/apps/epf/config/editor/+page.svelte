<script lang="ts">
	import { configFileNameProblem, configRelativePathProblem } from "$epf/util/config-files.ts";
	import { CURRENT_CONFIG_VERSION } from "$epf/util/config-schema.ts";
	import { errorMessage } from "$epf/util/errors.ts";
	import { isWithinPath } from "$epf/platform/path.ts";

	import ConfigNode from "../ConfigNode.svelte";
	import { configEditor } from "$lib/epf/config-editor.svelte.ts";
	import {
		downloadTextFile,
		pathKey,
		sourceDisplayLabel,
		sourceFileName,
		sourceKey
	} from "$lib/epf/config-model.ts";
	import { configHref } from "$lib/epf/routes.ts";
	import { epfSession } from "$lib/epf/session";

	import type { ConfigIssue, ConfigSource } from "$epf/util/config-loader.ts";

	let message = $state("");
	let actionIssues = $state<string[]>([]);
	let loadError = $state("");
	let showSaveAs = $state(false);
	let saveName = $state("epf.toml");
	let saveTarget = $state<"workspace" | "home" | "s3">("workspace");
	let saveOverwrite = $state(false);
	let saveForce = $state(false);
	let saveMakeDefault = $state(false);
	let saveError = $state("");
	let s3TestMessage = $state("");
	let s3TestError = $state(false);
	let s3Testing = $state(false);
	let showRename = $state(false);
	let renameName = $state("");
	let renameError = $state("");

	const { busy, configLoaded, configIssues, envValues, configText, activeWorkspace, configSource, writeBlocked } = epfSession;
	const canWrite = $derived($writeBlocked === null);
	const s3Settings = $derived.by(() => {
		void $envValues;
		return epfSession.getS3Settings();
	});
	const issueList = $derived(
		configEditor.validation !== null && !configEditor.validation.ok
			? configEditor.validation.structuredIssues
			: []
	);
	const warnings = $derived(configEditor.warnings);
	const canSave = $derived(
		configEditor.hasDocument &&
		!configEditor.readOnly &&
		configEditor.validation !== null &&
		configEditor.validation.ok
	);
	const homeDir = $derived(epfSession.getHomeDir());
	const engineLabel = $derived(
		$configSource === null
			? "no config"
			: sourceDisplayLabel($configSource, homeDir, $activeWorkspace?.path ?? null)
	);
	const editorIsApplied = $derived(
		$configSource !== null &&
		sourceKey($configSource) === configEditor.sourceKey &&
		!configEditor.dirty
	);
	const sourceIsHome = $derived.by(() => {
		const source = configEditor.source;
		return source?.kind === "path" && homeDir.length > 0 && isWithinPath(source.path, homeDir);
	});

	const resetFeedback = (): void => {
		message = "";
		actionIssues = [];
		loadError = "";
	};

	const fail = (err: unknown): void => {
		const text = errorMessage(err);
		message = text;
		actionIssues = text.split("\n");
	};

	const testS3 = async (): Promise<void> => {
		s3Testing = true;
		s3TestMessage = "";
		s3TestError = false;
		try {
			const result = await epfSession.testS3Connection(saveName);
			s3TestError = !result.ok;
			s3TestMessage = result.ok
				? `Connected to ${result.bucket} using ${result.addressingStyle} addressing (key: ${result.key}).`
				: result.message;
		} catch (err) {
			s3TestError = true;
			s3TestMessage = errorMessage(err);
		} finally {
			s3Testing = false;
		}
	};

	// Keep a clean editor in sync when the engine reloads the same source from
	// the console. Unsaved work is never replaced silently.
	$effect(() => {
		const text = $configText;
		const source = $configSource;
		if (source === null || text.length === 0) {
			return;
		}
		if (sourceKey(source) !== configEditor.sourceKey || !configEditor.hasDocument) {
			return;
		}
		if (text === configEditor.sourceText) {
			return;
		}
		if (configEditor.readOnly) {
			return;
		}
		if (!configEditor.dirty) {
			try {
				configEditor.openText(text, source);
			} catch (err) {
				loadError = errorMessage(err);
			}
		} else {
			configEditor.markExternalChange();
		}
	});

	const restoreConflict = async (): Promise<void> => {
		const draft = configEditor.draftNotice?.draft ?? null;
		if (draft === null) {
			return;
		}
		try {
			await configEditor.restoreDraft(draft);
			message = "Restored the unsaved draft.";
		} catch (err) {
			fail(err);
		}
	};

	const discardConflict = async (): Promise<void> => {
		const key = configEditor.sourceKey;
		const source = configEditor.source;
		configEditor.clearDraftNotice();
		try {
			await epfSession.deleteEditorDraft(key);
			if (source !== null) {
				const document = await epfSession.openConfigDocument(source);
				configEditor.openDocument(document);
			} else {
				configEditor.newDocument();
			}
		} catch (err) {
			fail(err);
		}
	};

	const startNew = async (): Promise<void> => {
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
	};

	const save = async (): Promise<void> => {
		resetFeedback();
		if (configEditor.pendingMigration !== null) {
			message = "Migrate the config before saving it.";
			return;
		}
		if (!canSave) {
			message = "Fix the validation issues before saving.";
			return;
		}
		const source = configEditor.source;
		if (source?.kind !== "path") {
			openSaveAs();
			return;
		}
		try {
			const text = configEditor.previewText;
			const saved = await epfSession.saveConfigToPath(source.path, text);
			await configEditor.commitSaved(saved, text);
			message = `Saved ${sourceFileName(saved)}.`;
		} catch (err) {
			fail(err);
		}
	};

	const applySession = async (): Promise<void> => {
		resetFeedback();
		if (!canSave) {
			message = "Fix the validation issues before applying the config.";
			return;
		}
		if (configEditor.source?.kind === "path" &&
			!confirm("Apply this config for the current tab session only? The file will not be changed.")) {
			return;
		}
		try {
			const text = configEditor.previewText;
			await epfSession.applyConfigText(text);
			const inline: ConfigSource = { kind: "inline", text, label: "session config" };
			await configEditor.commitSaved(inline, text);
			message = "Config applied for this session.";
		} catch (err) {
			fail(err);
		}
	};

	const openSaveAs = (): void => {
		resetFeedback();
		showSaveAs = true;
		showRename = false;
		saveName = sourceFileName(configEditor.source);
		if (configEditor.source?.kind === "url" && s3Settings.ok) {
			saveTarget = "s3";
		} else {
			saveTarget = sourceIsHome ? "home" : "workspace";
		}
		saveOverwrite = false;
		saveForce = false;
		saveMakeDefault = false;
		saveError = "";
		s3TestMessage = "";
		s3TestError = false;
	};

	const closeSaveAs = (): void => {
		showSaveAs = false;
		saveError = "";
	};

	const saveAs = async (): Promise<void> => {
		resetFeedback();
		saveError = "";
		const nameProblem = saveTarget === "home"
			? configFileNameProblem(saveName)
			: configRelativePathProblem(saveName);
		if (nameProblem !== null) {
			saveError = nameProblem;
			return;
		}
		try {
			const text = configEditor.previewText;
			if (saveTarget === "s3") {
				const saved = await epfSession.saveConfigToS3(text, {
					key: saveName,
					overwrite: saveOverwrite,
					force: saveForce
				});
				const label = `saved to s3://${saved.bucket}/${saved.key}`;
				if (saved.publicURL !== null) {
					try {
						await epfSession.loadConfigSource({ kind: "url", url: saved.publicURL });
						await configEditor.commitSaved({ kind: "url", url: saved.publicURL }, text);
						message = `Saved to s3://${saved.bucket}/${saved.key} and loaded ${saved.publicURL}.`;
					} catch (err) {
						await epfSession.applyConfigText(text, label);
						await configEditor.commitSaved({ kind: "inline", text, label }, text);
						message = `Saved to s3://${saved.bucket}/${saved.key}, but loading the public URL failed: ${errorMessage(err)}. The saved text is applied for this session.`;
					}
				} else {
					await epfSession.applyConfigText(text, label);
					await configEditor.commitSaved({ kind: "inline", text, label }, text);
					message = `Saved to s3://${saved.bucket}/${saved.key}. Set EPF_S3_PUBLIC_BASE_URL to open it as a URL.`;
				}
				showSaveAs = false;
				return;
			}
			const source = saveTarget === "home"
				? await epfSession.saveConfigToHome(text, saveName, {
					overwrite: saveOverwrite,
					makeDefault: saveMakeDefault
				})
				: await epfSession.saveConfigToWorkspace(text, saveName, { overwrite: saveOverwrite });
			await configEditor.commitSaved(source, text);
			showSaveAs = false;
			message = `Saved ${sourceFileName(source)}.`;
		} catch (err) {
			saveError = errorMessage(err);
		}
	};

	const openRename = (): void => {
		if (configEditor.source?.kind !== "path") {
			return;
		}
		if (configEditor.dirty) {
			message = "Save or discard your changes before renaming the file.";
			return;
		}
		showRename = true;
		showSaveAs = false;
		renameName = sourceFileName(configEditor.source);
		renameError = "";
	};

	const rename = async (): Promise<void> => {
		const source = configEditor.source;
		if (source?.kind !== "path") {
			return;
		}
		renameError = "";
		const problem = configFileNameProblem(renameName);
		if (problem !== null) {
			renameError = problem;
			return;
		}
		try {
			const next = await epfSession.renameConfigFile(source.path, renameName);
			await configEditor.commitSaved(next, configEditor.sourceText);
			showRename = false;
			message = `Renamed the config to ${sourceFileName(next)}.`;
		} catch (err) {
			renameError = errorMessage(err);
		}
	};

	const discard = (): void => {
		if (!confirm("Discard the unsaved changes and reload the source?")) {
			return;
		}
		resetFeedback();
		void configEditor.discard();
	};

	const exportToml = (): void => {
		if (!configEditor.isValid && !confirm("The config is not valid. Export it anyway?")) {
			return;
		}
		downloadTextFile(sourceFileName(configEditor.source), configEditor.previewText);
	};

	const copyToml = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(configEditor.previewText);
			message = "TOML copied to the clipboard.";
		} catch (err) {
			fail(err);
		}
	};

	const acceptMigration = (): void => {
		configEditor.acceptMigration();
		message = "Migrated in memory. Review the changes, then save or apply.";
	};

	const showReadOnly = (): void => {
		configEditor.showMigrationReadOnly();
		message = "Opened as a read-only preview.";
	};

	const cancelMigration = (): void => {
		configEditor.cancelMigration();
	};

	const focusIssue = (issue: ConfigIssue): void => {
		const id = `config-field-${pathKey(issue.path)}`;
		const element = document.getElementById(id);
		if (element === null) {
			return;
		}
		let details = element.closest("details");
		while (details !== null) {
			details.open = true;
			details = details.parentElement?.closest("details") ?? null;
		}
		element.scrollIntoView({ block: "center" });
		// A Markdown field keeps its textarea unfocusable while idle (so the
		// highlighted mirror is the only searchable copy); focus the field, which
		// reveals the editor and hands it the caret.
		const field = element.closest(".md-field");
		if (field instanceof HTMLElement && field.tabIndex >= 0) {
			field.focus();
			return;
		}
		(element as HTMLElement).focus?.();
	};
</script>

	{#if loadError.length > 0}
		<article class="message is-danger is-small">
			<div class="message-body">{loadError}</div>
		</article>
	{/if}

	{#if configEditor.error !== null}
		<article class="message is-danger is-small">
			<div class="message-body">{configEditor.error}</div>
		</article>
	{/if}

	{#if configEditor.pendingMigration !== null}
		<article class="message is-warning">
			<div class="message-header"><p>This config needs migration</p></div>
			<div class="message-body">
				<p>
					The config uses schema version <strong>{configEditor.pendingMigration.fromVersion}</strong>.
					This build supports version <strong>{CURRENT_CONFIG_VERSION}</strong>.
				</p>
				{#if configEditor.pendingMigration.steps.length > 0}
					<ul class="mt-2">
						{#each configEditor.pendingMigration.steps as step (step.from)}
							<li>v{step.from} → v{step.to}: {step.description}</li>
						{/each}
					</ul>
				{/if}
				<p class="help mt-2">Migrating happens in memory. The file is only rewritten when you save.</p>
				<div class="buttons mt-3">
					<button type="button" class="button is-small is-primary" onclick={acceptMigration}>Migrate and edit</button>
					<button type="button" class="button is-small" onclick={showReadOnly}>Open read-only</button>
					<button type="button" class="button is-small" onclick={cancelMigration}>Cancel</button>
				</div>
			</div>
		</article>
	{:else if configEditor.opening}
		<progress class="progress is-small is-info" max="100"></progress>
	{:else if !configEditor.hasDocument}
		<article class="message is-info">
			<div class="message-body">
				<p>No config is open in the editor.</p>
				<p class="help">Open a library or workspace file, import a TOML file, or start from the default config.</p>
				<div class="buttons mt-3">
					<button type="button" class="button is-small is-primary" onclick={() => void startNew()}>New config</button>
					<a class="button is-small" href={configHref("library")}>Open from library</a>
					<a class="button is-small" href={configHref("library")}>Import .toml</a>
				</div>
			</div>
		</article>
	{:else}
		{#if configEditor.migratedFrom !== null}
			<article class="message is-info is-small">
				<div class="message-body">
					Migrated from schema v{configEditor.migratedFrom} to v{configEditor.configVersion}. Saving will rewrite the file in the new format.
				</div>
			</article>
		{/if}

		{#if configEditor.readOnly}
			<article class="message is-warning is-small">
				<div class="message-body">
					{#if (configEditor.documentVersion ?? CURRENT_CONFIG_VERSION) < CURRENT_CONFIG_VERSION}
						This older config is shown read-only. Reopen it and choose Migrate to edit it.
					{:else}
						This config is version {configEditor.documentVersion ?? "unknown"}; this build understands version
						{CURRENT_CONFIG_VERSION}. It is read-only here. Update the dashboard to edit a newer config.
					{/if}
				</div>
			</article>
		{/if}

		{#if configEditor.externalChange}
			<article class="message is-warning is-small">
				<div class="message-body">
					The loaded config changed outside the editor. Save or discard your changes, then reload the config from
					the Library tab.
				</div>
			</article>
		{/if}

		{#if configEditor.draftNotice !== null}
			<article class={"message is-small " + (configEditor.draftNotice.kind === "conflict" ? "is-warning" : "is-success")}>
				<div class="message-body">
					<p>{configEditor.draftNotice.message}</p>
					{#if configEditor.draftNotice.kind === "conflict"}
						<div class="buttons mt-2">
							<button type="button" class="button is-small is-primary" onclick={() => void restoreConflict()}>Restore draft</button>
							<button type="button" class="button is-small" onclick={() => void discardConflict()}>Keep the file</button>
						</div>
					{/if}
				</div>
			</article>
		{/if}

		{#if configEditor.draftError !== null}
			<article class="message is-warning is-small">
				<div class="message-body">Could not save the editor draft: {configEditor.draftError}</div>
			</article>
		{/if}

		{#if !editorIsApplied && !configEditor.readOnly && configEditor.pendingMigration === null}
			<p class="help mb-2">
				Engine: {engineLabel}. This editor document is not applied yet — press Apply or Save to use it.
			</p>
		{/if}

		<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
			<div class="buttons mb-0">
				<button type="button" class="button is-small is-primary" onclick={() => void save()} disabled={$busy || !canWrite || !canSave || configEditor.readOnly}>
					Save
				</button>
				<button type="button" class="button is-small" onclick={openSaveAs} disabled={$busy || !canWrite || !canSave || configEditor.readOnly}>Save as…</button>
				<button type="button" class="button is-small" onclick={() => void applySession()} disabled={$busy || !canWrite || !canSave || configEditor.readOnly}>Apply for this session</button>
				<button type="button" class="button is-small" onclick={openRename} disabled={$busy || !canWrite || configEditor.readOnly || configEditor.source?.kind !== "path" || configEditor.dirty}>Rename</button>
				<button type="button" class="button is-small" onclick={exportToml}>Export .toml</button>
				<button type="button" class="button is-small" onclick={() => void copyToml()}>Copy TOML</button>
				<button type="button" class="button is-small is-light" onclick={discard} disabled={!configEditor.dirty && configEditor.pendingMigration === null}>Discard</button>
			</div>
			<div class="has-text-right">
				{#if configEditor.lastDraftSavedAt !== null}
					<span class="tag is-small is-light">draft saved {new Date(configEditor.lastDraftSavedAt).toLocaleTimeString()}</span>
				{/if}
			</div>
		</div>

		{#if showSaveAs}
			<article class="message is-info is-small">
				<div class="message-body">
					<div class="field is-grouped">
						<div class="control">
							<label class="label is-small" for="save-target">Destination</label>
							<div class="select is-small">
								<select
									id="save-target"
									value={saveTarget}
									onchange={(event) => (saveTarget = event.currentTarget.value as "workspace" | "home" | "s3")}
								>
									<option value="workspace">Active workspace</option>
									<option value="home">Config library</option>
									<option value="s3">S3 bucket</option>
								</select>
							</div>
						</div>
						<div class="control is-expanded">
							<label class="label is-small" for="save-name">{saveTarget === "s3" ? (s3Settings.ok && s3Settings.settings.prefix.length > 0 ? "Object key (under prefix)" : "Object key") : "File name"}</label>
							<input id="save-name" class="input is-small" bind:value={saveName} />
						</div>
					</div>
					<label class="checkbox is-size-7 mr-4" for="save-overwrite">
						<input id="save-overwrite" type="checkbox" class="mr-2" bind:checked={saveOverwrite} />
						Overwrite if it exists
					</label>
					{#if saveTarget === "s3"}
						{#if s3Settings.ok}
							<p class="help mt-2">
								Bucket <strong>{s3Settings.settings.bucket}</strong> at <code>{s3Settings.settings.endpoint}</code>.
								{#if s3Settings.settings.prefix.length > 0}
									Saved keys use the prefix <code>{s3Settings.settings.prefix}</code>.
								{/if}
								The config may contain API keys, so keep the bucket private unless a public config is intended.
								The bucket must allow CORS from this page for PUT and HEAD, allow the headers the AWS
								SDK sends (authorization, x-amz-*, amz-sdk-*, content-type and if-*), and expose the ETag response header.
							</p>
							<div class="buttons mt-2 mb-0">
								<button
									type="button"
									class="button is-small is-light"
									onclick={() => void testS3()}
									disabled={s3Testing || $busy}
								>
									{s3Testing ? "Testing…" : "Test connection"}
								</button>
							</div>
							{#if s3TestMessage.length > 0}
								<p class="help {s3TestError ? "is-danger" : "is-success"}">{s3TestMessage}</p>
							{/if}
						{:else}
							<p class="help is-danger mt-2">{s3Settings.message}</p>
							<a class="button is-small is-text" href={configHref("environment")}>
								Open Environment settings
							</a>
						{/if}
						{#if saveOverwrite}
							<div class="mt-2">
								<label class="checkbox is-size-7" for="save-force">
									<input id="save-force" type="checkbox" class="mr-2" bind:checked={saveForce} />
									Ignore the ETag check (force overwrite)
								</label>
								<p class="help is-danger">
									This can overwrite an edit another person saved after your last read. Use it only after
									checking the remote file.
								</p>
							</div>
						{/if}
					{/if}
					{#if saveTarget === "home"}
						<label class="checkbox is-size-7" for="save-default">
							<input id="save-default" type="checkbox" class="mr-2" bind:checked={saveMakeDefault} />
							Make it the library default
						</label>
					{/if}
					{#if saveError.length > 0}
						<p class="help is-danger mt-2">{saveError}</p>
					{/if}
					<div class="buttons mt-2">
						<button type="button" class="button is-small is-primary" onclick={() => void saveAs()} disabled={$busy || !canWrite}>Save</button>
						<button type="button" class="button is-small" onclick={closeSaveAs}>Cancel</button>
					</div>
				</div>
			</article>
		{/if}

		{#if showRename}
			<article class="message is-info is-small">
				<div class="message-body">
					<label class="label is-small" for="rename-name">New file name</label>
					<input id="rename-name" class="input is-small" bind:value={renameName} />
					{#if renameError.length > 0}
						<p class="help is-danger mt-2">{renameError}</p>
					{/if}
					<div class="buttons mt-2">
						<button type="button" class="button is-small is-primary" onclick={() => void rename()} disabled={$busy || !canWrite}>Rename</button>
						<button type="button" class="button is-small" onclick={() => (showRename = false)}>Cancel</button>
					</div>
				</div>
			</article>
		{/if}

		{#if issueList.length > 0}
			<article class="message is-danger is-small">
				<div class="message-header"><p>{issueList.length} validation issue{issueList.length === 1 ? "" : "s"}</p></div>
				<div class="message-body">
					<ul>
						{#each issueList as issue, index (index)}
							<li>
								<button type="button" class="button is-small is-text" onclick={() => focusIssue(issue)}>
									{issue.path.length > 0 ? issue.path.join(".") : "config"}: {issue.message}
								</button>
							</li>
						{/each}
					</ul>
				</div>
			</article>
		{/if}

		{#if warnings.length > 0}
			<article class="message is-warning is-small">
				<div class="message-body">
					<ul>
						{#each warnings as warning, index (index)}
							<li>{warning}</li>
						{/each}
					</ul>
				</div>
			</article>
		{/if}

		{#if $configIssues.length > 0 && !configLoaded}
			<article class="message is-warning is-small">
				<div class="message-header"><p>The engine could not load its config</p></div>
				<div class="message-body">
					<ul>
						{#each $configIssues as issue, index (index)}
							<li><code>{issue}</code></li>
						{/each}
					</ul>
				</div>
			</article>
		{/if}

		{#if !configEditor.readOnly}
			<div class="buttons has-addons mb-3">
				<button type="button" class={"button is-small" + (configEditor.mode === "form" ? " is-primary" : "")} onclick={() => (configEditor.mode = "form")}>Form</button>
				<button type="button" class={"button is-small" + (configEditor.mode === "preview" ? " is-primary" : "")} onclick={() => (configEditor.mode = "preview")}>TOML preview</button>
			</div>
		{/if}

		{#if configEditor.mode === "preview" || configEditor.readOnly}
			<pre class="config-preview">{configEditor.previewText}</pre>
			<p class="help mt-2">This is exactly what Save writes. Comments and original formatting are normalized.</p>
		{:else}
			{#key configEditor.sourceKey}
				<ConfigNode />
			{/key}
		{/if}
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

<style>
	.config-preview {
		font-size: 0.8rem;
		line-height: 1.4;
		max-height: 36rem;
		overflow: auto;
		background: var(--bulma-scheme-main-bis);
		color: var(--bulma-text);
		border: 1px solid var(--bulma-border-weak);
		border-radius: var(--bulma-radius);
		padding: 1rem;
	}
</style>
