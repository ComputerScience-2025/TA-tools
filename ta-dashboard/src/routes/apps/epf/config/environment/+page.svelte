<script lang="ts">
	import { onMount } from "svelte";

	import { ENV_VARS } from "$epf/util/env-vars.ts";
	import { errorMessage } from "$epf/util/errors.ts";

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
		epfSession.setEnv(spec.name, localEnv[spec.name] ?? "");
		appliedEnv[spec.name] = localEnv[spec.name] ?? "";
		message = `${spec.name} updated.`;
		actionIssues = [];
	};
</script>

<div class="columns">
	<div class="column is-7">
		<h3 class="subtitle is-6">Environment variables</h3>
		<p class="help mb-3">
			Values EPF reads from the environment. Values set here are remembered in this browser.
		</p>

		{#each ENV_VARS as spec (spec.name)}
			<div class="field">
				<label class="label is-small" for={`env-${spec.name}`}>{spec.name}</label>
				<p class="help">{spec.description}</p>
				<div class="field has-addons mb-0">
					<div class="control is-expanded">
						<input
							id={`env-${spec.name}`}
							class="input is-small"
							type="text"
							autocomplete="off"
							spellcheck="false"
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
				EPF's browser storage is not encrypted. Environment values, config drafts and library files are stored
				as plain text and may contain API keys. These are configuration values, not password-manager entries —
				do not reuse a real password. Use a private browser profile on shared machines.
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
