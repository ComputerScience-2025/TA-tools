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
	/** Last values copied from the session, to tell external changes from drafts. */
	let appliedEnv = $state<Record<string, string>>({});

	const { envValues } = epfSession;

	const syncEnvFromSession = (): void => {
		const values: Record<string, string> = {};
		for (const spec of ENV_VARS) {
			values[spec.name] = epfSession.getEnv(spec.name);
		}
		localEnv = values;
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
		const remember = spec.secret ? $epfRememberSecrets : true;
		epfSession.setEnv(spec.name, localEnv[spec.name] ?? "", remember);
		appliedEnv[spec.name] = localEnv[spec.name] ?? "";
		message = `${spec.name} updated${remember ? " and remembered in this browser" : " for this session"}.`;
		actionIssues = [];
	};

	const setRememberSecrets = (allowed: boolean): void => {
		epfRememberSecrets.set(allowed);
		if (allowed) {
			// Secrets applied while the switch was off only live in memory; persist
			// them now, since the switch is the only per-secret control.
			for (const spec of ENV_VARS) {
				if (!spec.secret) {
					continue;
				}
				const value = epfSession.getEnv(spec.name);
				if (value.length > 0) {
					epfSession.setEnv(spec.name, value, true);
				}
			}
			message = "Secrets will now be remembered in this browser.";
		} else {
			epfSession.forgetPersistedSecrets();
			message = "Secrets will no longer be remembered on this device.";
		}
		actionIssues = [];
	};
</script>

<div class="columns">
	<div class="column is-7">
		<h3 class="subtitle is-6">Environment variables</h3>
		<p class="help mb-3">
			Values EPF reads from the environment. Non-secret values are remembered in this browser; secrets are
			remembered only when the switch below is on.
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
					<div class="control">
						<button
							id={`env-clear-${spec.name}`}
							class="button is-small is-text"
							onclick={() => {
								epfSession.clearEnv(spec.name);
								localEnv[spec.name] = "";
							}}
						>
							Clear
						</button>
					</div>
				</div>
			</div>
		{/each}
	</div>
	<div class="column is-5">
		<article class="message is-warning is-small">
			<div class="message-body">
				Config drafts and library files are always stored in IndexedDB, even when secret remembering is off. They
				include any API keys the config contains. Use a private browser profile on shared machines.
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
