<script lang="ts">
	import type { ConfigPath } from "$epf/util/config-object.ts";
	import type { ConfigFieldDescriptor } from "$epf/util/config-form-schema.ts";
	import { errorMessage } from "$epf/util/errors.ts";

	import MarkdownField from "./MarkdownField.svelte";
	import { configEditor, configFormDescriptor, configFormError } from "$lib/epf/config-editor.svelte.ts";
	import {
		arrayItemLabel,
		enumLabel,
		fieldHelp,
		fieldLabel,
		pathKey,
		suggestRecordKey
	} from "$lib/epf/config-model.ts";

	let keyDrafts = $state<Record<string, string>>({});
	let keyErrors = $state<Record<string, string>>({});
	let rowErrors = $state<Record<string, string>>({});
	let newKeys = $state<Record<string, string>>({});
	let adding = $state<Record<string, boolean>>({});

	const UNSUPPORTED: ConfigFieldDescriptor = {
		key: null,
		kind: "unsupported",
		required: true,
		hasDefault: false
	};

	const visibleProperties = (descriptor: ConfigFieldDescriptor): ConfigFieldDescriptor[] =>
		(descriptor.properties ?? []).filter((property) => property.hidden !== true);

	const isWide = (descriptor: ConfigFieldDescriptor): boolean =>
		descriptor.kind === "array" ||
		descriptor.kind === "record" ||
		descriptor.kind === "object" ||
		descriptor.widget === "textarea";

	const stringValue = (path: ConfigPath): string => {
		const value = configEditor.valueAt(path);
		if (value === undefined || value === null) {
			return "";
		}
		return typeof value === "string" ? value : String(value);
	};

	const enumValue = (path: ConfigPath, descriptor: ConfigFieldDescriptor): string => {
		const value = configEditor.valueAt(path);
		if (typeof value === "string") {
			return value;
		}
		const fallback = descriptor.defaultValue;
		return typeof fallback === "string" ? fallback : descriptor.enumValues?.[0] ?? "";
	};

	const numberValue = (path: ConfigPath): string => {
		const value = configEditor.valueAt(path);
		return typeof value === "number" ? String(value) : "";
	};

	const booleanValue = (path: ConfigPath, descriptor: ConfigFieldDescriptor): boolean => {
		const value = configEditor.valueAt(path);
		if (typeof value === "boolean") {
			return value;
		}
		return descriptor.defaultValue === true;
	};

	const referenceValue = (path: ConfigPath): string => {
		const value = configEditor.valueAt(path);
		return typeof value === "string" ? value : "";
	};

	const referenceOptions = (descriptor: ConfigFieldDescriptor): string[] => {
		if (descriptor.widget === "provider-reference") {
			return configEditor.providerKeys();
		}
		if (descriptor.widget === "model-reference") {
			return configEditor.modelKeys();
		}
		return [];
	};

	const canReset = (descriptor: ConfigFieldDescriptor): boolean =>
		!descriptor.required || descriptor.hasDefault;

	const numberInput = (path: ConfigPath, descriptor: ConfigFieldDescriptor, event: Event): void => {
		const input = event.currentTarget as HTMLInputElement;
		if (input.value.trim().length === 0) {
			if (descriptor.required) {
				configEditor.setField(path, descriptor.hasDefault ? descriptor.defaultValue : 0, descriptor);
			} else {
				configEditor.resetField(path);
			}
			return;
		}
		const value = input.valueAsNumber;
		if (Number.isNaN(value)) {
			return;
		}
		configEditor.setField(path, value, descriptor);
	};

	const setString = (path: ConfigPath, descriptor: ConfigFieldDescriptor, event: Event): void => {
		configEditor.setField(path, (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value, descriptor);
	};

	// --- Record entries -------------------------------------------------------

	const recordPointer = (path: ConfigPath): string => `record:${pathKey(path)}`;

	const recordEntryLabel = (path: ConfigPath): string => {
		const last = path[path.length - 1];
		if (last === "providers") {
			return "Provider name";
		}
		if (last === "models") {
			return "Model name";
		}
		if (last === "prompt_replacement") {
			return "Placeholder name";
		}
		if (last === "headers") {
			return "Header name";
		}
		return "Entry name";
	};

	const entryPointer = (path: ConfigPath, key: string): string => `entry:${pathKey(path)}:${key}`;

	const currentKeyDraft = (path: ConfigPath, key: string): string =>
		keyDrafts[entryPointer(path, key)] ?? key;

	const setKeyDraft = (path: ConfigPath, key: string, value: string): void => {
		keyDrafts[entryPointer(path, key)] = value;
	};

	const commitKey = (path: ConfigPath, key: string): void => {
		const pointer = entryPointer(path, key);
		const target = (keyDrafts[pointer] ?? key).trim();
		if (target.length === 0 || target === key) {
			delete keyDrafts[pointer];
			delete keyErrors[pointer];
			return;
		}
		try {
			configEditor.renameRecordEntry(path, key, target);
			delete keyDrafts[pointer];
			delete keyErrors[pointer];
		} catch (error) {
			keyErrors[pointer] = errorMessage(error);
		}
	};

	const cancelKeyEdit = (path: ConfigPath, key: string): void => {
		const pointer = entryPointer(path, key);
		delete keyDrafts[pointer];
		delete keyErrors[pointer];
	};

	const toggleAdding = (path: ConfigPath): void => {
		const pointer = recordPointer(path);
		if (adding[pointer] === true) {
			adding[pointer] = false;
			return;
		}
		adding[pointer] = true;
		newKeys[pointer] = suggestRecordKey(path, configEditor.recordKeys(path));
		delete rowErrors[`add:${pointer}`];
	};

	const addEntry = (path: ConfigPath, descriptor: ConfigFieldDescriptor): void => {
		const pointer = recordPointer(path);
		const key = (newKeys[pointer] ?? "").trim();
		try {
			configEditor.addRecordEntry(path, key, descriptor);
			adding[pointer] = false;
			delete rowErrors[`add:${pointer}`];
		} catch (error) {
			rowErrors[`add:${pointer}`] = errorMessage(error);
		}
	};

	const deleteEntry = (path: ConfigPath, key: string): void => {
		if (!confirm(`Delete "${key}"?`)) {
			return;
		}
		const pointer = recordPointer(path);
		try {
			configEditor.deleteRecordEntry(path, key);
			delete rowErrors[`delete:${pointer}`];
		} catch (error) {
			rowErrors[`delete:${pointer}`] = errorMessage(error);
		}
	};

	const duplicateEntry = (path: ConfigPath, key: string): void => {
		const pointer = recordPointer(path);
		try {
			configEditor.duplicateRecordEntry(path, key);
			delete rowErrors[`delete:${pointer}`];
		} catch (error) {
			rowErrors[`delete:${pointer}`] = errorMessage(error);
		}
	};

	// --- Arrays ----------------------------------------------------------------

	const arrayPointer = (path: ConfigPath): string => `array:${pathKey(path)}`;

	const addItem = (path: ConfigPath, descriptor: ConfigFieldDescriptor): void => {
		try {
			configEditor.addArrayItem(path, descriptor);
			delete rowErrors[arrayPointer(path)];
		} catch (error) {
			rowErrors[arrayPointer(path)] = errorMessage(error);
		}
	};

	const deleteItem = (path: ConfigPath, index: number, label: string): void => {
		if (!confirm(`Delete "${label}"?`)) {
			return;
		}
		try {
			configEditor.deleteArrayItem(path, index);
			delete rowErrors[arrayPointer(path)];
		} catch (error) {
			rowErrors[arrayPointer(path)] = errorMessage(error);
		}
	};

	const duplicateItem = (path: ConfigPath, index: number): void => {
		try {
			configEditor.duplicateArrayItem(path, index);
			delete rowErrors[arrayPointer(path)];
		} catch (error) {
			rowErrors[arrayPointer(path)] = errorMessage(error);
		}
	};
</script>

{#snippet issueMessages(issues: { message: string }[])}
	{#if issues.length > 0}
		<p class="help is-danger">
			{#each issues as issue, index (index)}
				{issue.message}{index < issues.length - 1 ? "; " : ""}
			{/each}
		</p>
	{/if}
{/snippet}

{#snippet arrayItemControls(path: ConfigPath, index: number, label: string, count: number)}
	<div class="buttons has-addons mb-0">
		<button
			type="button"
			class="button is-small"
			title="Move up"
			disabled={index === 0}
			onclick={() => configEditor.moveArrayItem(path, index, index - 1)}
		>↑</button>
		<button
			type="button"
			class="button is-small"
			title="Move down"
			disabled={index === count - 1}
			onclick={() => configEditor.moveArrayItem(path, index, index + 1)}
		>↓</button>
		<button type="button" class="button is-small" title="Duplicate" onclick={() => duplicateItem(path, index)}>Duplicate</button>
		<button type="button" class="button is-small is-danger is-light" onclick={() => deleteItem(path, index, label)}>Delete</button>
	</div>
{/snippet}

{#snippet renderNode(
	descriptor: ConfigFieldDescriptor,
	path: ConfigPath,
	heading: string,
	compact: boolean
)}
	{@const id = `config-field-${pathKey(path)}`}
	{@const issues = configEditor.issuesFor(path)}

	{#if descriptor.hidden === true}
		<!-- Hidden fields are still preserved in the document. -->
	{:else if descriptor.kind === "object"}
		{#if path.length === 0}
			<div class="columns is-multiline">
				{#each visibleProperties(descriptor) as property (property.key)}
					<div class="column is-12">
						{@render renderNode(
							property,
							[...path, property.key as string],
							fieldLabel([...path, property.key as string], property),
							false
						)}
					</div>
				{/each}
			</div>
		{:else if heading.length === 0}
			<div class="columns is-multiline">
				{#each visibleProperties(descriptor) as property (property.key)}
					<div class={isWide(property) ? "column is-12" : "column is-6"}>
						{@render renderNode(
							property,
							[...path, property.key as string],
							fieldLabel([...path, property.key as string], property),
							false
						)}
					</div>
				{/each}
			</div>
		{:else}
			<details class="config-object box p-4" open={path.length <= 2}>
				<summary class="config-object-title">
					<span>{heading}</span>
					{#if issues.length > 0}
						<span class="tag is-warning is-light ml-2">{issues.length} issue{issues.length === 1 ? "" : "s"}</span>
					{/if}
				</summary>
				<div class="mt-3">
					{@render issueMessages(issues)}
					<div class="columns is-multiline">
						{#each visibleProperties(descriptor) as property (property.key)}
							<div class={isWide(property) ? "column is-12" : "column is-6"}>
								{@render renderNode(
									property,
									[...path, property.key as string],
									fieldLabel([...path, property.key as string], property),
									false
								)}
							</div>
						{/each}
					</div>
				</div>
			</details>
		{/if}
	{:else if descriptor.kind === "record"}
		{@const recordPointerValue = recordPointer(path)}
		<div class="config-record box p-4">
			<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
				<div>
					<h4 class="title is-6 mb-0">{heading.length > 0 ? heading : "Entries"}</h4>
					{#if fieldHelp(path) !== null}
						<p class="help">{fieldHelp(path)}</p>
					{/if}
				</div>
				<div class="buttons">
					{#if canReset(descriptor)}
						<button type="button" class="button is-small is-text" onclick={() => configEditor.resetField(path)}>Reset</button>
					{/if}
					<button type="button" class="button is-small is-light" onclick={() => toggleAdding(path)}>Add entry</button>
				</div>
			</div>

			{@render issueMessages(issues)}

			{#if adding[recordPointerValue] === true}
				<div class="field has-addons mb-3">
					<div class="control is-expanded">
						<input
							class="input is-small"
							placeholder={suggestRecordKey(path, configEditor.recordKeys(path))}
							value={newKeys[recordPointerValue] ?? ""}
							oninput={(event) => (newKeys[recordPointerValue] = event.currentTarget.value)}
							onkeydown={(event) => {
								if (event.key === "Enter") {
									addEntry(path, descriptor);
								}
							}}
						/>
					</div>
					<div class="control">
						<button type="button" class="button is-small is-primary" onclick={() => addEntry(path, descriptor)}>Add</button>
					</div>
					<div class="control">
						<button type="button" class="button is-small" onclick={() => toggleAdding(path)}>Cancel</button>
					</div>
				</div>
				{#if rowErrors[`add:${recordPointerValue}`]}
					<p class="help is-danger">{rowErrors[`add:${recordPointerValue}`]}</p>
				{/if}
			{/if}

			{#if configEditor.recordKeys(path).length === 0}
				<p class="is-size-7 has-text-grey">No entries yet.</p>
			{:else}
				{#each configEditor.recordKeys(path) as key, index (key)}
					{@const entryPath = [...path, key]}
					{@const entryPointerValue = entryPointer(path, key)}
					<div class="config-entry box p-3 mb-2">
						<div class="is-flex is-justify-content-space-between is-align-items-center mb-2">
							<div class="control is-expanded mr-3">
								<div class="field has-addons mb-0">
									<div class="control is-expanded">
										<input
											class="input is-small is-family-monospace"
											aria-label={recordEntryLabel(path)}
											title="Press Enter or click Rename to apply a new name"
											value={currentKeyDraft(path, key)}
											oninput={(event) => setKeyDraft(path, key, event.currentTarget.value)}
											onkeydown={(event) => {
												if (event.key === "Enter") {
													commitKey(path, key);
												} else if (event.key === "Escape") {
													cancelKeyEdit(path, key);
												}
											}}
										/>
									</div>
									{#if currentKeyDraft(path, key) !== key}
										<div class="control">
											<button type="button" class="button is-small is-light" onclick={() => commitKey(path, key)}>Rename</button>
										</div>
									{/if}
								</div>
								{#if keyErrors[entryPointerValue]}
									<p class="help is-danger">{keyErrors[entryPointerValue]}</p>
								{/if}
							</div>
							<div class="buttons has-addons mb-0">
								<button
									type="button"
									class="button is-small"
									title="Move up"
									disabled={index === 0}
									onclick={() => configEditor.moveRecordEntry(path, key, -1)}
								>↑</button>
								<button
									type="button"
									class="button is-small"
									title="Move down"
									disabled={index === configEditor.recordKeys(path).length - 1}
									onclick={() => configEditor.moveRecordEntry(path, key, 1)}
								>↓</button>
								<button type="button" class="button is-small" title="Duplicate" onclick={() => duplicateEntry(path, key)}>Duplicate</button>
								<button type="button" class="button is-small is-danger is-light" onclick={() => deleteEntry(path, key)}>Delete</button>
							</div>
						</div>
						{@render renderNode(descriptor.additional ?? UNSUPPORTED, entryPath, "", true)}
					</div>
				{/each}
			{/if}
			{#if rowErrors[`delete:${recordPointerValue}`]}
				<p class="help is-danger">{rowErrors[`delete:${recordPointerValue}`]}</p>
			{/if}
		</div>
	{:else if descriptor.kind === "array"}
		{@const arrayPointerValue = arrayPointer(path)}
		<div class="config-array box p-4">
			<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
				<div>
					<h4 class="title is-6 mb-0">{heading.length > 0 ? heading : "Items"}</h4>
					{#if fieldHelp(path) !== null}
						<p class="help">{fieldHelp(path)}</p>
					{/if}
				</div>
				<div class="buttons">
					{#if canReset(descriptor)}
						<button type="button" class="button is-small is-text" onclick={() => configEditor.resetField(path)}>Reset</button>
					{/if}
					<button type="button" class="button is-small is-light" onclick={() => addItem(path, descriptor)}>Add item</button>
				</div>
			</div>

			{@render issueMessages(issues)}

			{#if configEditor.arrayItems(path).length === 0}
				<p class="is-size-7 has-text-grey">No items yet.</p>
			{:else}
				{#each configEditor.arrayItems(path) as item, index (index)}
					{@const itemPath = [...path, index]}
					{@const itemLabel = arrayItemLabel(path, item, index)}
					{@const itemDescriptor = descriptor.items ?? UNSUPPORTED}
					{@const scalarItem =
						itemDescriptor.kind === "string" ||
						itemDescriptor.kind === "number" ||
						itemDescriptor.kind === "integer" ||
						itemDescriptor.kind === "boolean" ||
						itemDescriptor.kind === "enum"}
					<div class="config-array-item box p-3 mb-2">
						{#if scalarItem}
							<div class="config-array-scalar is-flex is-align-items-center">
								<span class="tag is-small is-light mr-2" title={itemLabel}>{index + 1}</span>
								<div class="is-flex-grow-1">
									{@render renderNode(itemDescriptor, itemPath, "", true)}
								</div>
								<div class="ml-2">
									{@render arrayItemControls(path, index, itemLabel, configEditor.arrayItems(path).length)}
								</div>
							</div>
						{:else}
							<div class="is-flex is-justify-content-space-between is-align-items-center mb-2">
								<span class="tag is-small is-light" title={itemLabel}>{index + 1}</span>
								{@render arrayItemControls(path, index, itemLabel, configEditor.arrayItems(path).length)}
							</div>
							{@render renderNode(itemDescriptor, itemPath, "", true)}
						{/if}
					</div>
				{/each}
			{/if}
			{#if rowErrors[arrayPointerValue]}
				<p class="help is-danger">{rowErrors[arrayPointerValue]}</p>
			{/if}
		</div>
	{:else if descriptor.kind === "enum"}
		{@const current = enumValue(path, descriptor)}
		<div class="field">
			{#if !compact}
				<label class="label is-small" for={id}>{fieldLabel(path, descriptor)}</label>
			{/if}
			<div class="select is-small is-fullwidth">
				<select
					id={id}
					value={current}
					onchange={(event) => configEditor.setField(path, event.currentTarget.value, descriptor)}
				>
					{#each descriptor.enumValues ?? [] as option (option)}
						<option value={option}>{enumLabel(option)}</option>
					{/each}
				</select>
			</div>
			{@render issueMessages(issues)}
			{#if !compact && fieldHelp(path) !== null}
				<p class="help">{fieldHelp(path)}</p>
			{/if}
		</div>
	{:else if descriptor.kind === "boolean"}
		{@const checked = booleanValue(path, descriptor)}
		<div class="field">
			<label class="checkbox is-size-7" for={id}>
				<input
					id={id}
					type="checkbox"
					class="mr-2"
					checked={checked}
					onchange={(event) => configEditor.setField(path, event.currentTarget.checked, descriptor)}
				/>
				{compact ? (heading.length > 0 ? heading : fieldLabel(path, descriptor)) : fieldLabel(path, descriptor)}
			</label>
			{@render issueMessages(issues)}
			{#if !compact && fieldHelp(path) !== null}
				<p class="help">{fieldHelp(path)}</p>
			{/if}
		</div>
	{:else if descriptor.widget === "seed"}
		{@const hasSeed = configEditor.hasValue(path)}
		{@const seed = configEditor.valueAt(path)}
		<div class="field">
			{#if !compact}
				<label class="label is-small" for={id}>{fieldLabel(path, descriptor)}</label>
			{/if}
			<label class="checkbox is-size-7 mb-2" for={`${id}-pin`}>
				<input
					id={`${id}-pin`}
					type="checkbox"
					class="mr-2"
					checked={hasSeed}
					onchange={(event) => {
						if (event.currentTarget.checked) {
							configEditor.setField(path, Math.floor(Date.now() / 1000), descriptor);
						} else {
							configEditor.resetField(path);
						}
					}}
				/>
				Pin a fixed seed
			</label>
			{#if hasSeed}
				<input
					id={id}
					class="input is-small"
					type="number"
					step="1"
					value={typeof seed === "number" ? seed : ""}
					oninput={(event) => numberInput(path, descriptor, event)}
				/>
			{/if}
			{@render issueMessages(issues)}
			{#if !compact && fieldHelp(path) !== null}
				<p class="help">{fieldHelp(path)}</p>
			{/if}
		</div>
	{:else if descriptor.widget === "provider-reference" || descriptor.widget === "model-reference"}
		{@const current = referenceValue(path)}
		{@const options = referenceOptions(descriptor)}
		<div class="field">
			{#if !compact}
				<label class="label is-small" for={id}>{fieldLabel(path, descriptor)}</label>
			{/if}
			{#if options.length === 0}
				<input
					id={id}
					class="input is-small"
					placeholder={descriptor.widget === "provider-reference" ? "provider name" : "model name"}
					value={current}
					oninput={(event) => configEditor.setField(path, event.currentTarget.value, descriptor)}
				/>
				<p class="help is-warning">Add a {descriptor.widget === "provider-reference" ? "provider" : "model"} first.</p>
			{:else}
				<div class="select is-small is-fullwidth">
					<select
						id={id}
						value={current}
						onchange={(event) => configEditor.setField(path, event.currentTarget.value, descriptor)}
					>
						{#if current.length > 0 && !options.includes(current)}
							<option value={current}>{current} (not defined)</option>
						{/if}
						{#each options as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</div>
				{#if current.length > 0 && !options.includes(current)}
					<p class="help is-warning">"{current}" is not defined. Create it or choose another entry.</p>
				{/if}
			{/if}
			{@render issueMessages(issues)}
			{#if !compact && fieldHelp(path) !== null}
				<p class="help">{fieldHelp(path)}</p>
			{/if}
		</div>
	{:else if descriptor.kind === "number" || descriptor.kind === "integer"}
		<div class="field">
			{#if !compact}
				<label class="label is-small" for={id}>{fieldLabel(path, descriptor)}</label>
			{/if}
			<input
				id={id}
				class="input is-small"
				type="number"
				step={descriptor.kind === "integer" ? "1" : "any"}
				min={descriptor.minimum}
				max={descriptor.maximum}
				value={numberValue(path)}
				oninput={(event) => numberInput(path, descriptor, event)}
			/>
			{@render issueMessages(issues)}
			{#if !compact && fieldHelp(path) !== null}
				<p class="help">{fieldHelp(path)}</p>
			{/if}
		</div>
	{:else if descriptor.kind === "string"}
		{@const value = stringValue(path)}
		<div class="field">
			{#if !compact}
				<div class="is-flex is-justify-content-space-between is-align-items-center">
					<label class="label is-small mb-0" for={id}>{fieldLabel(path, descriptor)}</label>
					{#if canReset(descriptor)}
						<button
							type="button"
							class="button is-small is-text"
							title="Reset to the default (removes the field)"
							onclick={() => configEditor.resetField(path)}
						>Reset</button>
					{/if}
				</div>
			{/if}
			{#if descriptor.widget === "textarea"}
				<MarkdownField
					{id}
					value={value}
					rows={5}
					disabled={configEditor.readOnly}
					onInput={(next) => configEditor.setField(path, next, descriptor)}
				/>
			{:else}
				<input
					id={id}
					class="input is-small"
					autocomplete="off"
					spellcheck="false"
					value={value}
					oninput={(event) => setString(path, descriptor, event)}
				/>
			{/if}
			{@render issueMessages(issues)}
			{#if !compact && fieldHelp(path) !== null}
				<p class="help">{fieldHelp(path)}</p>
			{/if}
		</div>
	{:else}
		<div class="field">
			{#if !compact}
				<span class="label is-small">{fieldLabel(path, descriptor)}</span>
			{/if}
			<pre class="is-size-7 config-readonly-value">{JSON.stringify(configEditor.valueAt(path), null, 2)}</pre>
			<p class="help">This field type is not editable here; it is preserved on export.</p>
		</div>
	{/if}
{/snippet}

{#if configFormError !== null}
	<article class="message is-danger">
		<div class="message-header"><p>The config form could not be generated</p></div>
		<div class="message-body">
			<p>{configFormError}</p>
			<p class="help">The backend schema changed in a way the editor does not understand. Import/export still works.</p>
		</div>
	</article>
{:else if configFormDescriptor !== null}
	<fieldset class="config-form" disabled={configEditor.readOnly}>
		{@render renderNode(configFormDescriptor, [], "", false)}
	</fieldset>
{/if}

<style>
	.config-form :global(.config-object-title) {
		cursor: pointer;
		font-weight: 600;
	}

	/* Chrome computes content-box for descendants of the <details> boxes, but
	   Bulma assumes border-box. Restore it so controls do not overflow their
	   wrappers and paint over the help text. */
	.config-form :global(*) {
		box-sizing: border-box;
	}

	.config-array-scalar :global(.field) {
		margin-bottom: 0;
	}

	.config-entry {
		background: var(--bulma-scheme-main-bis);
	}

	.config-readonly-value {
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
