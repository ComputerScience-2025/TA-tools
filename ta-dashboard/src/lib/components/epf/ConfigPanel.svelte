<script lang="ts">
	import { onMount } from "svelte";

	import { epfRememberSecrets } from "$lib/epf/settings";
	import { epfSession } from "$lib/epf/session";

	import { ENV_VARS } from "$epf/util/env-vars.ts";
	import type { EnvVarSpec } from "$epf/util/env-vars.ts";

	let draft = $state("");
	let draftDirty = $state(false);
	let issues = $state<string[]>([]);
	let message = $state("");
	let workspaceConfigs = $state<string[]>([]);
	let urlInput = $state("");
	let localEnv = $state<Record<string, string>>({});
	let localPersist = $state<Record<string, boolean>>({});
	let storageMaxMb = $state(0);
	let storageFileMb = $state(0);
	let storageTtlDays = $state(0);
	let lastConfigText = "";
	let lastWorkspacePath = "";

	const { configLoaded, configSourceLabel, configIssues, envValues, busy, configText, activeWorkspace } = epfSession;
	const sourceLabel = $derived($configSourceLabel);

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
			} catch {
				// The page-level session error explains why the controls are inert.
				return;
			}
			draft = $configText;
			lastConfigText = draft;
			syncEnvFromSession();
			syncStorageFromSession();
		})();
	});

	// Config values can change outside this panel (console reload, a fetch that
	// adopts a repo config). Keep an untouched editor in sync, but never
	// overwrite unsaved edits.
	$effect(() => {
		const text = $configText;
		if (!draftDirty && text !== lastConfigText) {
			draft = text;
			lastConfigText = text;
		}
	});

	// This panel stays mounted while another tab is active, so it cannot rely on
	// onMount to notice the active workspace changing.
	$effect(() => {
		const path = $activeWorkspace?.path ?? "";
		if (path === lastWorkspacePath) {
			return;
		}
		lastWorkspacePath = path;
		void (async () => {
			try {
				const configs = await epfSession.detectWorkspaceConfigs();
				if (($activeWorkspace?.path ?? "") === path) {
					workspaceConfigs = configs;
				}
			} catch {
				if (($activeWorkspace?.path ?? "") === path) {
					workspaceConfigs = [];
				}
			}
		})();
	});

	const syncEnvFromSession = (): void => {
		const values: Record<string, string> = {};
		const persisted: Record<string, boolean> = {};
		for (const spec of ENV_VARS) {
			values[spec.name] = epfSession.getEnv(spec.name);
			persisted[spec.name] = $envValues.find((entry) => entry.name === spec.name)?.persisted ?? false;
		}
		localEnv = values;
		localPersist = persisted;
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

	const validate = (): void => {
		const result = epfSession.validateConfigText(draft);
		issues = result.ok ? [] : result.issues;
		message = result.ok ? "Config text is valid." : result.message;
	};

	const apply = async (): Promise<void> => {
		issues = [];
		message = "";
		try {
			await epfSession.applyConfigText(draft);
			draftDirty = false;
			draft = $configText;
			message = "Config applied for this session.";
			workspaceConfigs = await epfSession.detectWorkspaceConfigs();
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
			issues = message.split("\n");
		}
	};

	const saveToWorkspace = async (): Promise<void> => {
		issues = [];
		message = "";
		try {
			await epfSession.saveConfigText(draft);
			draftDirty = false;
			draft = $configText;
			message = "Config saved into the active workspace as epf.toml.";
			workspaceConfigs = await epfSession.detectWorkspaceConfigs();
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
			issues = message.split("\n");
		}
	};

	const loadFromInput = async (): Promise<void> => {
		if (urlInput.trim().length === 0) {
			return;
		}
		issues = [];
		message = "";
		try {
			await epfSession.loadConfigFromInput(urlInput.trim());
			draftDirty = false;
			draft = $configText;
			message = `Config loaded from ${urlInput.trim()}.`;
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
			issues = message.split("\n");
		}
	};

	const loadFromWorkspace = async (name: string): Promise<void> => {
		issues = [];
		message = "";
		try {
			await epfSession.loadConfigFromWorkspace(name);
			draftDirty = false;
			draft = $configText;
			message = `Config loaded from ${name}.`;
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
			issues = message.split("\n");
		}
	};

	const applyStorageSettings = async (): Promise<void> => {
		const totalMb = Number(storageMaxMb);
		const fileMb = Number(storageFileMb);
		const ttlDays = Number(storageTtlDays);
		if (![totalMb, fileMb, ttlDays].every((value) => Number.isFinite(value) && value >= 1)) {
			issues = ["Total, per-file and TTL values must be finite numbers of at least 1."];
			message = "Storage limits were not changed.";
			return;
		}
		issues = [];
		message = "";
		try {
			await epfSession.setStorageSettings({
				maxTotalBytes: Math.round(totalMb) * 1024 * 1024,
				maxFileBytes: Math.round(fileMb) * 1024 * 1024,
				sourceTtlDays: Math.round(ttlDays)
			});
			syncStorageFromSession();
			message = "Storage limits updated.";
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
			issues = message.split("\n");
		}
	};

	const applyEnv = (spec: EnvVarSpec): void => {
		// The switch is the master gate for secrets. Non-secret values (the
		// config URL) are remembered like ordinary dashboard preferences.
		const remember = spec.secret
			? $epfRememberSecrets && localPersist[spec.name] === true
			: true;
		epfSession.setEnv(spec.name, localEnv[spec.name] ?? "", remember);
		message = `${spec.name} updated${remember ? " and remembered in this browser" : " for this session"}.`;
	};

	const setRememberSecrets = (allowed: boolean): void => {
		epfRememberSecrets.set(allowed);
		if (!allowed) {
			epfSession.forgetPersistedSecrets();
			syncEnvFromSession();
			message = "Secrets will no longer be remembered on this device.";
		}
	};
</script>

<div class="columns">
	<div class="column is-7">
		<div class="is-flex is-justify-content-space-between is-align-items-center">
			<h3 class="subtitle is-6">Configuration (TOML)</h3>
			<span class="tag is-small">{sourceLabel ?? "no config loaded"}</span>
		</div>

		<textarea
			class="textarea is-family-monospace config-editor"
			rows="18"
			spellcheck="false"
			bind:value={draft}
			oninput={() => (draftDirty = true)}
			placeholder="Paste an epf.toml here, or load one from the workspace or a URL."
		></textarea>

		<div class="buttons mt-2">
			<button class="button is-small" onclick={validate}>Validate</button>
			<button class="button is-small is-primary" onclick={() => void apply()} disabled={$busy}>Apply (this session)</button>
			<button class="button is-small" onclick={() => void saveToWorkspace()} disabled={$busy}>Save into workspace</button>
			{#if $configLoaded}
				<span class="tag is-success is-light ml-2">engine ready</span>
			{/if}
		</div>

		<div class="field is-grouped mt-3">
			<div class="control is-expanded">
				<input class="input is-small" placeholder="https://…/epf.toml or /epf/workspaces/…/epf.toml" bind:value={urlInput} />
			</div>
			<div class="control">
				<button class="button is-small" onclick={() => void loadFromInput()} disabled={$busy}>Load from path / URL</button>
			</div>
		</div>
		<p class="help">
			The source field maps to <code>EPF_CONFIG_URL</code>; without either, EPF looks for <code>epf.toml</code> in the
			active workspace.
		</p>

		{#if workspaceConfigs.length > 0}
			<p class="mt-3 mb-1 is-size-7">Configs found in this workspace:</p>
			<div class="buttons">
				{#each workspaceConfigs as candidate (candidate)}
					<button class="button is-small is-light" onclick={() => void loadFromWorkspace(candidate)}>{candidate}</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="column is-5">
		<h3 class="subtitle is-6">Environment variables</h3>
		<p class="help mb-3">
			A browser has no environment, so the variables EPF reads are set here. Secrets stay in memory unless
			"remember" is ticked; other values are remembered in this browser.
		</p>

		<label class="checkbox is-size-7 mb-3" for="remember-secrets">
			<input
				id="remember-secrets"
				type="checkbox"
				class="mr-2"
				checked={$epfRememberSecrets}
				onchange={(event) => setRememberSecrets(event.currentTarget.checked)}
			/>
			Allow remembering secrets in this browser
		</label>

		{#each ENV_VARS as spec (spec.name)}
			<div class="field">
				<label class="label is-small" for={`env-${spec.name}`}>{spec.name}</label>
				<div class="field has-addons">
					<div class="control is-expanded">
						<input
							id={`env-${spec.name}`}
							class="input is-small"
							type={spec.secret ? "password" : "text"}
							placeholder={spec.example ?? ""}
							bind:value={localEnv[spec.name]}
						/>
					</div>
					<div class="control">
						<button id={`env-set-${spec.name}`} class="button is-small" onclick={() => applyEnv(spec)}>Set</button>
					</div>
				</div>
				<div class="is-flex is-justify-content-space-between is-align-items-center mt-1">
					{#if spec.secret}
						<label class="checkbox is-size-7" for={`persist-${spec.name}`}>
							<input
								id={`persist-${spec.name}`}
								type="checkbox"
								class="mr-2"
								disabled={!$epfRememberSecrets}
								checked={localPersist[spec.name] === true}
								onchange={(event) => {
									localPersist[spec.name] = event.currentTarget.checked;
								}}
							/>
							Remember on this device
						</label>
					{:else}
						<span></span>
					{/if}
					<button id={`env-clear-${spec.name}`} class="button is-small is-text" onclick={() => {
						epfSession.clearEnv(spec.name);
						localEnv[spec.name] = "";
						localPersist[spec.name] = false;
					}}>Clear</button>
				</div>
				<p class="help">{spec.description}</p>
			</div>
		{/each}

		<h3 class="subtitle is-6 mt-5">Browser storage limits</h3>
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
		<button class="button is-small" onclick={() => void applyStorageSettings()} disabled={$busy}>Apply limits</button>
		<p class="help mt-2">
			When the total is exceeded, the least recently used unpinned workspace is deleted first. Pinned workspaces
			and the active one are never removed automatically.
		</p>
	</div>
</div>

{#if $configIssues.length > 0}
	<article class="message is-warning is-small">
		<div class="message-header"><p>Config source could not be loaded</p></div>
		<div class="message-body">
			<ul>
				{#each $configIssues as issue, index (index)}
					<li><code>{issue}</code></li>
				{/each}
			</ul>
		</div>
	</article>
{/if}

{#if message.length > 0}
	<article class="message is-small {issues.length > 0 ? "is-danger" : "is-info"}">
		<div class="message-body">
			<p>{message}</p>
			{#if issues.length > 0}
				<ul class="mt-2">
					{#each issues as issue, index (index)}
						<li><code>{issue}</code></li>
					{/each}
				</ul>
			{/if}
		</div>
	</article>
{/if}

<style>
	.config-editor {
		font-size: 0.8rem;
		line-height: 1.4;
		tab-size: 4;
	}
</style>
