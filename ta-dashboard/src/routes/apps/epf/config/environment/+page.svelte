<script lang="ts">
	import { onMount } from "svelte";

	import { ENV_VARS } from "$epf/util/env-vars.ts";
	import { errorMessage } from "$epf/util/errors.ts";

	import { epfRememberSecrets } from "$lib/epf/settings";
	import { epfSession } from "$lib/epf/session";

	import type { EnvVarSpec } from "$epf/util/env-vars.ts";

	let message = $state("");
	let actionIssues = $state<string[]>([]);
	let localEnv = $state<Record<string, string>>({});
	let localPersist = $state<Record<string, boolean>>({});
	/** Last values copied from the session, to tell external changes from drafts. */
	let appliedEnv = $state<Record<string, string>>({});

	const { envValues } = epfSession;

	const syncEnvFromSession = (): void => {
		const values: Record<string, string> = {};
		const persisted: Record<string, boolean> = {};
		for (const spec of ENV_VARS) {
			values[spec.name] = epfSession.getEnv(spec.name);
			persisted[spec.name] = $envValues.find((entry) => entry.name === spec.name)?.persisted ?? false;
		}
		localEnv = values;
		localPersist = persisted;
		appliedEnv = { ...values };
	};

	const fail = (err: unknown): void => {
		const text = errorMessage(err);
		message = text;
		actionIssues = text.split("\n");
	};

	onMount(() => {
		void (async () => {
			try {
				await epfSession.ensure();
			} catch (err) {
				fail(err);
				return;
			}
			syncEnvFromSession();
		})();
	});

	// Values can change outside this page (a shared link writing
	// EPF_CONFIG_URL, another section). Reflect them without overwriting a
	// value the user has typed but not applied.
	$effect(() => {
		const entries = $envValues;
		for (const spec of ENV_VARS) {
			const stored = entries.find((entry) => entry.name === spec.name)?.value ?? "";
			const local = localEnv[spec.name] ?? "";
			if (local === (appliedEnv[spec.name] ?? "") && local !== stored) {
				localEnv[spec.name] = stored;
			}
			if (appliedEnv[spec.name] !== stored) {
				appliedEnv[spec.name] = stored;
			}
		}
	});

	const applyEnv = (spec: EnvVarSpec): void => {
		const remember = spec.secret
			? $epfRememberSecrets && localPersist[spec.name] === true
			: true;
		epfSession.setEnv(spec.name, localEnv[spec.name] ?? "", remember);
		message = `${spec.name} updated${remember ? " and remembered in this browser" : " for this session"}.`;
		actionIssues = [];
	};

	const setRememberSecrets = (allowed: boolean): void => {
		epfRememberSecrets.set(allowed);
		if (!allowed) {
			epfSession.forgetPersistedSecrets();
			syncEnvFromSession();
			message = "Secrets will no longer be remembered on this device.";
			actionIssues = [];
		}
	};
</script>

<div class="columns">
	<div class="column is-7">
		<h3 class="subtitle is-6">Environment variables</h3>
		<p class="help mb-3">
			A browser has no environment, so the variables EPF reads are set here. Secrets stay in memory unless
			"remember" is ticked; other values are remembered in this browser. This switch does not affect config drafts
			or saved configs, which always persist.
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
				<p class="help">{spec.description}</p>
				<div class="field has-addons mb-0">
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
				<div class="is-flex is-justify-content-space-between is-align-items-center mt-2">
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
			</div>
		{/each}
	</div>
	<div class="column is-5">
		<article class="message is-warning is-small">
			<div class="message-body">
				Config drafts and library files are stored in IndexedDB so a refresh does not lose work. They include any
				API keys the config contains. Use a private browser profile on shared machines.
			</div>
		</article>
	</div>
</div>

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
