import { parse as parseToml } from "smol-toml";

import {
	addRecordEntry,
	appendArrayItem,
	cloneConfigValue,
	createDefaultDocument,
	deleteArrayItem,
	deleteAtPath,
	deleteRecordEntry,
	getArrayAt,
	getAtPath,
	getRecordAt,
	hasAtPath,
	insertArrayItem,
	migrateConfigDocument,
	moveArrayItem,
	moveRecordEntry,
	modelKeyReferences,
	providerKeyReferences,
	renameModelKey,
	renameProviderKey,
	renameRecordEntry,
	serializeConfigDocument,
	setAtPath,
	uniqueKey,
	validateConfigDocument
} from "$epf/util/config-object.ts";
import {
	buildConfigFormDescriptor,
	collectUnknownConfigPaths,
	createValueForDescriptor,
	findDescriptor
} from "$epf/util/config-form-schema.ts";
import { CURRENT_CONFIG_VERSION } from "$epf/util/config-schema.ts";
import { detectConfigVersion, migrationSteps } from "$epf/util/config-migrations.ts";
import { hashText } from "$epf/util/editor-draft.ts";
import type {
	ConfigPath,
	RawConfigObject
} from "$epf/util/config-object.ts";
import type {
	ConfigFieldDescriptor,
	ConfigFormDescriptorResult
} from "$epf/util/config-form-schema.ts";
import type { ConfigIssue, ConfigSource, ConfigValidation } from "$epf/util/config-loader.ts";
import type { MigrationStep } from "$epf/util/config-migrations.ts";
import type { EditorDraft } from "$epf/util/editor-draft.ts";
import type { OpenedConfigDocument } from "$epf/hosts/web-host.ts";

import {
	duplicateArrayItemOverrides,
	newArrayItemOverrides,
	sourceFileName,
	sourceKey
} from "./config-model.ts";
import { epfSession } from "./session.ts";

export type EditorMode = "form" | "preview";

export type PendingMigration = {
	text: string;
	raw: RawConfigObject;
	fromVersion: number;
	source: ConfigSource;
	steps: MigrationStep[];
};

export type DraftNotice = {
	kind: "restored" | "conflict";
	message: string;
	draft: EditorDraft | null;
};

export type OpenDocumentResult =
	| { kind: "ready" }
	| { kind: "migration"; fromVersion: number }
	| { kind: "newer"; version: number };

const FORM_RESULT: ConfigFormDescriptorResult = buildConfigFormDescriptor();

export const configFormDescriptor: ConfigFieldDescriptor | null = FORM_RESULT.ok ? FORM_RESULT.descriptor : null;
export const configFormError: string | null = FORM_RESULT.ok ? null : FORM_RESULT.message;

const TOML = {
	parse(text: string): Record<string, unknown> {
		return parseToml(text) as Record<string, unknown>;
	}
};

const AUTOSAVE_DELAY_MS = 750;

function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((entry, index) => sameValue(entry, right[index]));
	}
	if (typeof left === "object" && left !== null && typeof right === "object" && right !== null && !Array.isArray(left) && !Array.isArray(right)) {
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const keys = Object.keys(leftRecord);
		return keys.length === Object.keys(rightRecord).length &&
			keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]));
	}
	return false;
}

function issueMatches(issue: ConfigIssue, path: ConfigPath): boolean {
	if (issue.path.length !== path.length) {
		return false;
	}
	return path.every((segment, index) => issue.path[index] === segment);
}

function pathStartsWith(path: ConfigPath, prefix: ConfigPath): boolean {
	if (path.length < prefix.length) {
		return false;
	}
	return prefix.every((segment, index) => path[index] === segment);
}

export class ConfigEditor {
	raw = $state.raw<RawConfigObject>({});
	revision = $state(0);
	/** Schema version detected in the opened document (not the raw fallback). */
	documentVersion = $state<number | null>(null);
	source = $state<ConfigSource | null>(null);
	sourceText = $state("");
	baseHash = $state("");
	migratedFrom = $state<number | null>(null);
	dirty = $state(false);
	readOnly = $state(false);
	hasDocument = $state(false);
	mode = $state<EditorMode>("form");
	validation = $state<ConfigValidation | null>(null);
	previewText = $state("");
	unknownPaths = $state<string[]>([]);
	warnings = $state<string[]>([]);
	pendingMigration = $state<PendingMigration | null>(null);
	draftNotice = $state<DraftNotice | null>(null);
	externalChange = $state(false);
	lastDraftSavedAt = $state<number | null>(null);
	draftError = $state<string | null>(null);
	error = $state<string | null>(null);

	private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	private draftQueue: Promise<void> = Promise.resolve();
	/**
	 * Bumped whenever the document is saved/discarded/renamed. A save already in
	 * flight checks it so an old draft cannot be resurrected after commit.
	 */
	private draftEpoch = 0;
	private started = false;
	private readonly onPageHide = (): void => {
		void this.flushDraft();
	};
	private readonly onVisibilityChange = (): void => {
		if (document.visibilityState === "hidden") {
			void this.flushDraft();
		}
	};

	get sourceKey(): string {
		return sourceKey(this.source);
	}

	get fileName(): string {
		return sourceFileName(this.source);
	}

	get issues(): ConfigIssue[] {
		return this.validation !== null && !this.validation.ok ? this.validation.structuredIssues : [];
	}

	get isValid(): boolean {
		return this.validation === null || this.validation.ok;
	}

	get configVersion(): number {
		return this.documentVersion ?? CURRENT_CONFIG_VERSION;
	}

	get descriptor(): ConfigFieldDescriptor | null {
		return configFormDescriptor;
	}

	get isCurrentVersion(): boolean {
		return this.configVersion === CURRENT_CONFIG_VERSION;
	}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		globalThis.addEventListener?.("pagehide", this.onPageHide);
		globalThis.document?.addEventListener("visibilitychange", this.onVisibilityChange);
	}

	stop(): void {
		if (!this.started) {
			return;
		}
		this.started = false;
		globalThis.removeEventListener?.("pagehide", this.onPageHide);
		globalThis.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
		void this.flushDraft();
	}

	// --- Opening -------------------------------------------------------------

	openDocument(document: OpenedConfigDocument): OpenDocumentResult {
		return this.applyParsed(document.text, document.raw, document.version, document.source);
	}

	openText(text: string, source: ConfigSource | null, options: { baseText?: string; dirty?: boolean } = {}): OpenDocumentResult {
		const parsed = this.parse(text);
		const result = this.applyParsed(text, parsed.raw, parsed.version, source);
		if (options.baseText !== undefined) {
			this.sourceText = options.baseText;
			this.baseHash = hashText(options.baseText);
		}
		if (options.dirty === true) {
			this.dirty = true;
			this.scheduleAutosave();
		}
		return result;
	}

	openImported(text: string, label: string): OpenDocumentResult {
		const parsed = this.parse(text);
		return this.applyParsed(text, parsed.raw, parsed.version, {
			kind: "inline",
			text,
			label: `imported: ${label}`
		});
	}

	private parse(text: string): { raw: RawConfigObject; version: number } {
		if (text.trim().length === 0) {
			throw new Error("The config file is empty.");
		}
		try {
			const raw = TOML.parse(text);
			return { raw, version: detectConfigVersion(raw) };
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}
	}

	private applyParsed(
		text: string,
		raw: RawConfigObject,
		version: number,
		source: ConfigSource | null
	): OpenDocumentResult {
		this.error = null;
		this.externalChange = false;
		this.draftNotice = null;
		this.lastDraftSavedAt = null;
		this.draftError = null;
		this.mode = "form";
		this.source = source;
		this.sourceText = text;
		this.baseHash = hashText(text);
		this.migratedFrom = null;
		this.documentVersion = version;

		if (version > CURRENT_CONFIG_VERSION) {
			this.raw = raw;
			this.pendingMigration = null;
			this.readOnly = true;
			this.hasDocument = true;
			this.dirty = false;
			this.changed({ dirty: false, validate: false });
			return { kind: "newer", version };
		}

		if (version < CURRENT_CONFIG_VERSION) {
			let steps: MigrationStep[] = [];
			try {
				steps = migrationSteps(version);
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
			this.raw = raw;
			this.pendingMigration = { text, raw, fromVersion: version, source: source ?? { kind: "inline", text, label: "config" }, steps };
			this.readOnly = true;
			this.hasDocument = true;
			this.dirty = false;
			this.changed({ dirty: false, validate: false });
			return { kind: "migration", fromVersion: version };
		}

		this.raw = raw;
		this.pendingMigration = null;
		this.readOnly = false;
		this.hasDocument = true;
		this.dirty = false;
		this.changed({ dirty: false });
		return { kind: "ready" };
	}

	newDocument(): void {
		this.raw = createDefaultDocument();
		this.source = null;
		this.sourceText = "";
		this.baseHash = "";
		this.documentVersion = CURRENT_CONFIG_VERSION;
		this.migratedFrom = null;
		this.draftNotice = null;
		this.mode = "form";
		this.pendingMigration = null;
		this.readOnly = false;
		this.hasDocument = true;
		this.dirty = false;
		this.externalChange = false;
		this.changed({ dirty: false });
	}

	acceptMigration(): void {
		const pending = this.pendingMigration;
		if (pending === null) {
			return;
		}
		try {
			const migrated = migrateConfigDocument(pending.raw);
			this.raw = migrated.raw;
			this.documentVersion = CURRENT_CONFIG_VERSION;
			this.source = pending.source;
			this.sourceText = pending.text;
			this.baseHash = hashText(pending.text);
			this.migratedFrom = pending.fromVersion;
			this.readOnly = false;
			this.pendingMigration = null;
			this.hasDocument = true;
			this.draftNotice = null;
			this.mode = "form";
			this.changed();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	/** Open the outdated document as a read-only preview. */
	showMigrationReadOnly(): void {
		const pending = this.pendingMigration;
		if (pending === null) {
			return;
		}
		this.raw = pending.raw;
		this.source = pending.source;
		this.sourceText = pending.text;
		this.baseHash = hashText(pending.text);
		this.migratedFrom = null;
		this.readOnly = true;
		this.pendingMigration = null;
		this.hasDocument = true;
		this.changed({ dirty: false, validate: false });
	}

	cancelMigration(): void {
		this.pendingMigration = null;
		this.error = null;
		this.raw = {};
		this.source = null;
		this.sourceText = "";
		this.baseHash = "";
		this.documentVersion = null;
		this.hasDocument = false;
		this.readOnly = false;
		this.dirty = false;
		this.validation = null;
		this.previewText = "";
		this.unknownPaths = [];
		this.warnings = [];
	}

	// --- Synchronization -----------------------------------------------------

	private changed(options: { dirty?: boolean; validate?: boolean } = {}): void {
		this.revision += 1;
		try {
			this.previewText = serializeConfigDocument(this.raw);
		} catch (error) {
			this.previewText = "";
			this.error = error instanceof Error ? error.message : String(error);
		}
		if (options.validate === false || this.readOnly) {
			this.validation = null;
		} else {
			const label = this.source === null ? "unsaved config" : this.fileName;
			this.validation = validateConfigDocument(this.raw, label);
		}
		if (configFormDescriptor !== null) {
			this.unknownPaths = collectUnknownConfigPaths(this.raw, configFormDescriptor);
		}
		this.warnings = this.computeWarnings();
		if (options.dirty !== false && !this.readOnly && this.hasDocument) {
			this.dirty = true;
		}
		if (this.dirty && this.hasDocument && !this.readOnly) {
			this.scheduleAutosave();
		}
	}

	private computeWarnings(): string[] {
		const warnings: string[] = [];
		for (const collection of ["analysis_workflows", "testing_workflows"] as const) {
			const value = this.raw[collection];
			if (!Array.isArray(value)) {
				continue;
			}
			const slugs = new Map<string, number>();
			const outputs = new Map<string, number>();
			value.forEach((entry) => {
				if (typeof entry !== "object" || entry === null) {
					return;
				}
				const record = entry as Record<string, unknown>;
				const slug = record["slug"];
				if (typeof slug === "string" && slug.length > 0) {
					slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
				}
				const output = record["output_filename"];
				if (
					typeof output === "string" &&
					output.length > 0 &&
					!output.includes("[slug]") &&
					!output.includes("[seed]")
				) {
					outputs.set(output, (outputs.get(output) ?? 0) + 1);
				}
			});
			for (const [slug, count] of slugs) {
				if (count > 1) {
					warnings.push(`${collection}: slug "${slug}" is used ${count} times.`);
				}
			}
			for (const [output, count] of outputs) {
				if (count > 1) {
					warnings.push(`${collection}: output filename "${output}" is used ${count} times.`);
				}
			}
		}
		const providers = getRecordAt(this.raw, ["llm", "providers"]);
		if (providers !== null) {
			for (const [name, provider] of Object.entries(providers)) {
				if (typeof provider === "object" && provider !== null) {
					const key = (provider as Record<string, unknown>)["api_key"];
					if (typeof key === "string" && key.trim().length === 0) {
						warnings.push(`Provider "${name}" has an empty API key.`);
					}
				}
			}
		}
		if (this.unknownPaths.length > 0) {
			warnings.push(
				`${this.unknownPaths.length} field(s) are preserved but not editable: ${this.unknownPaths.slice(0, 6).join(", ")}` +
				(this.unknownPaths.length > 6 ? "…" : "")
			);
		}
		return warnings;
	}

	// --- Values and issues ---------------------------------------------------

	valueAt(path: ConfigPath): unknown {
		void this.revision;
		return getAtPath(this.raw, path);
	}

	hasValue(path: ConfigPath): boolean {
		void this.revision;
		return hasAtPath(this.raw, path);
	}

	descriptorAt(path: ConfigPath): ConfigFieldDescriptor | null {
		return configFormDescriptor === null ? null : findDescriptor(configFormDescriptor, path);
	}

	effectiveValue(path: ConfigPath, descriptor: ConfigFieldDescriptor): unknown {
		if (this.hasValue(path)) {
			return this.valueAt(path);
		}
		if (descriptor.hasDefault) {
			return descriptor.defaultValue;
		}
		switch (descriptor.kind) {
			case "array":
				return [];
			case "record":
			case "object":
				return {};
			case "boolean":
				return false;
			case "number":
			case "integer":
				return 0;
			case "enum":
				return descriptor.enumValues?.[0] ?? "";
			case "string":
				return "";
			default:
				return null;
		}
	}

	issuesFor(path: ConfigPath): ConfigIssue[] {
		void this.revision;
		if (this.validation === null || this.validation.ok) {
			return [];
		}
		return this.validation.structuredIssues.filter((issue) => issueMatches(issue, path));
	}

	issuesUnder(path: ConfigPath): ConfigIssue[] {
		void this.revision;
		if (this.validation === null || this.validation.ok) {
			return [];
		}
		return this.validation.structuredIssues.filter((issue) => pathStartsWith(issue.path, path));
	}

	setField(path: ConfigPath, value: unknown, descriptor: ConfigFieldDescriptor): void {
		if (this.readOnly) {
			return;
		}
		if (!descriptor.required && descriptor.hasDefault && sameValue(value, descriptor.defaultValue) && !this.hasValue(path)) {
			return;
		}
		setAtPath(this.raw, path, value);
		this.changed();
	}

	resetField(path: ConfigPath): void {
		if (this.readOnly) {
			return;
		}
		deleteAtPath(this.raw, path);
		this.changed();
	}

	addArrayItem(path: ConfigPath, descriptor: ConfigFieldDescriptor): void {
		if (this.readOnly || descriptor.kind !== "array" || descriptor.items === undefined) {
			return;
		}
		const value = createValueForDescriptor(descriptor.items);
		const overrides = newArrayItemOverrides(path, this.raw);
		appendArrayItem(this.raw, path, this.mergeOverrides(value, overrides));
		this.changed();
	}

	duplicateArrayItem(path: ConfigPath, index: number): void {
		if (this.readOnly) {
			return;
		}
		const array = getArrayAt(this.raw, path);
		if (array === null || index < 0 || index >= array.length) {
			return;
		}
		const item = cloneConfigValue(array[index]);
		const clone = this.mergeOverrides(item, duplicateArrayItemOverrides(path, item, this.raw));
		insertArrayItem(this.raw, path, index + 1, clone);
		this.changed();
	}

	deleteArrayItem(path: ConfigPath, index: number): void {
		if (this.readOnly) {
			return;
		}
		deleteArrayItem(this.raw, path, index);
		this.changed();
	}

	moveArrayItem(path: ConfigPath, from: number, to: number): void {
		if (this.readOnly) {
			return;
		}
		if (moveArrayItem(this.raw, path, from, to)) {
			this.changed();
		}
	}

	addRecordEntry(path: ConfigPath, key: string, descriptor: ConfigFieldDescriptor): void {
		if (this.readOnly || descriptor.kind !== "record" || descriptor.additional === undefined) {
			return;
		}
		const trimmed = key.trim();
		if (trimmed.length === 0) {
			throw new Error("Enter a name for the entry.");
		}
		const value = createValueForDescriptor(descriptor.additional);
		addRecordEntry(this.raw, path, trimmed, value);
		this.changed();
	}

	renameRecordEntry(path: ConfigPath, oldKey: string, newKey: string): void {
		if (this.readOnly) {
			return;
		}
		const trimmed = newKey.trim();
		if (trimmed.length === 0) {
			throw new Error("Enter a name for the entry.");
		}
		if (trimmed === oldKey) {
			return;
		}
		if (this.isProviderRecord(path)) {
			renameProviderKey(this.raw, oldKey, trimmed);
		} else if (this.isModelRecord(path)) {
			renameModelKey(this.raw, oldKey, trimmed);
		} else {
			renameRecordEntry(this.raw, path, oldKey, trimmed);
		}
		this.changed();
	}

	duplicateRecordEntry(path: ConfigPath, key: string): void {
		if (this.readOnly) {
			return;
		}
		const record = getRecordAt(this.raw, path);
		if (record === null || !Object.prototype.hasOwnProperty.call(record, key)) {
			return;
		}
		const base = `${key}_copy`;
		const nextKey = uniqueKey(Object.keys(record), base);
		addRecordEntry(this.raw, path, nextKey, cloneConfigValue(record[key]));
		this.changed();
	}

	deleteRecordEntry(path: ConfigPath, key: string): void {
		if (this.readOnly) {
			return;
		}
		if (this.isProviderRecord(path)) {
			const references = providerKeyReferences(this.raw, key);
			if (references.length > 0) {
				throw new Error(
					`Provider "${key}" is used by model(s): ${references.join(", ")}. Rename or remove them first.`
				);
			}
		}
		if (this.isModelRecord(path)) {
			const references = modelKeyReferences(this.raw, key);
			if (references.length > 0) {
				throw new Error(
					`Model "${key}" is used by: ${references.join(", ")}. Rename or remove them first.`
				);
			}
		}
		deleteRecordEntry(this.raw, path, key);
		this.changed();
	}

	moveRecordEntry(path: ConfigPath, key: string, offset: -1 | 1): void {
		if (this.readOnly) {
			return;
		}
		if (moveRecordEntry(this.raw, path, key, offset)) {
			this.changed();
		}
	}

	recordKeys(path: ConfigPath): string[] {
		void this.revision;
		const record = getRecordAt(this.raw, path);
		return record === null ? [] : Object.keys(record);
	}

	arrayItems(path: ConfigPath): unknown[] {
		void this.revision;
		return getArrayAt(this.raw, path) ?? [];
	}

	providerKeys(): string[] {
		void this.revision;
		const providers = getRecordAt(this.raw, ["llm", "providers"]);
		return providers === null ? [] : Object.keys(providers);
	}

	modelKeys(): string[] {
		void this.revision;
		const models = getRecordAt(this.raw, ["llm", "models"]);
		return models === null ? [] : Object.keys(models);
	}

	private isProviderRecord(path: ConfigPath): boolean {
		return path.length === 2 && path[0] === "llm" && path[1] === "providers";
	}

	private isModelRecord(path: ConfigPath): boolean {
		return path.length === 2 && path[0] === "llm" && path[1] === "models";
	}

	private mergeOverrides(value: unknown, overrides: Record<string, unknown>): unknown {
		if (Object.keys(overrides).length === 0) {
			return value;
		}
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return { ...(value as Record<string, unknown>), ...overrides };
		}
		return value;
	}

	// --- Saving and drafts ---------------------------------------------------

	adoptSource(source: ConfigSource, text: string): void {
		this.draftEpoch += 1;
		if (this.autosaveTimer !== undefined) {
			clearTimeout(this.autosaveTimer);
			this.autosaveTimer = undefined;
		}
		this.source = source;
		this.sourceText = text;
		this.baseHash = hashText(text);
		this.dirty = false;
		this.migratedFrom = null;
		this.externalChange = false;
		this.lastDraftSavedAt = null;
		this.draftNotice = null;
	}

	/** Adopt a source after Apply/Save/Rename and forget the old draft. */
	async commitSaved(source: ConfigSource, text: string): Promise<void> {
		const oldKey = this.sourceKey;
		if (this.autosaveTimer !== undefined) {
			clearTimeout(this.autosaveTimer);
			this.autosaveTimer = undefined;
		}
		this.adoptSource(source, text);
		try {
			await this.draftQueue;
			if (oldKey !== this.sourceKey) {
				await epfSession.deleteEditorDraft(oldKey);
			}
			await epfSession.deleteEditorDraft(this.sourceKey);
		} catch {
			// Draft cleanup is best-effort; the config is already saved.
		}
	}

	async discard(): Promise<void> {
		this.draftEpoch += 1;
		if (this.autosaveTimer !== undefined) {
			clearTimeout(this.autosaveTimer);
			this.autosaveTimer = undefined;
		}
		const key = this.sourceKey;
		await this.draftQueue;
		try {
			await epfSession.deleteEditorDraft(key);
		} catch {
			// Draft cleanup is best-effort.
		}
		this.draftNotice = null;
		if (this.sourceText.length > 0) {
			try {
				const baseSource = this.source;
				const baseText = this.sourceText;
				this.openText(baseText, baseSource);
				this.dirty = false;
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
			return;
		}
		this.newDocument();
		this.dirty = false;
	}

	async restoreDraft(draft: EditorDraft): Promise<void> {
		const baseText = this.sourceText;
		const baseHash = this.baseHash;
		const source = this.source;
		const parsed = this.parse(draft.text);
		this.applyParsed(draft.text, parsed.raw, parsed.version, source);
		this.sourceText = baseText;
		this.baseHash = baseHash;
		this.migratedFrom = draft.migratedFrom;
		this.dirty = true;
		this.draftNotice = {
			kind: "restored",
			message: `Restored an unsaved draft saved ${new Date(draft.savedAt).toLocaleString()}.`,
			draft
		};
		this.lastDraftSavedAt = draft.savedAt;
		this.changed();
	}

	markExternalChange(): void {
		if (this.hasDocument) {
			this.externalChange = true;
		}
	}

	clearDraftNotice(): void {
		this.draftNotice = null;
	}

	scheduleAutosave(): void {
		if (!this.hasDocument || !this.dirty || this.readOnly) {
			return;
		}
		if (this.autosaveTimer !== undefined) {
			clearTimeout(this.autosaveTimer);
		}
		this.autosaveTimer = setTimeout(() => {
			this.autosaveTimer = undefined;
			void this.flushDraft();
		}, AUTOSAVE_DELAY_MS);
	}

	async flushDraft(): Promise<void> {
		if (!this.hasDocument || !this.dirty || this.readOnly) {
			return;
		}
		const epoch = this.draftEpoch;
		const draft: EditorDraft = {
			sourceKey: this.sourceKey,
			sourceLabel: this.source === null ? "new config" : this.fileName,
			baseHash: this.baseHash,
			configVersion: this.configVersion,
			migratedFrom: this.migratedFrom,
			text: this.previewText,
			savedAt: Date.now()
		};
		this.draftQueue = this.draftQueue
			.then(async () => {
				if (epoch !== this.draftEpoch) {
					return;
				}
				await epfSession.saveEditorDraft(draft);
				if (epoch === this.draftEpoch) {
					this.lastDraftSavedAt = draft.savedAt;
					this.draftError = null;
				}
			})
			.catch((error: unknown) => {
				this.draftError = error instanceof Error ? error.message : String(error);
			});
		await this.draftQueue;
	}

	async clearDraft(): Promise<void> {
		this.draftEpoch += 1;
		if (this.autosaveTimer !== undefined) {
			clearTimeout(this.autosaveTimer);
			this.autosaveTimer = undefined;
		}
		await this.draftQueue;
		try {
			await epfSession.deleteEditorDraft(this.sourceKey);
		} catch {
			// A missing/corrupt draft must not block applying or saving.
		}
		this.lastDraftSavedAt = null;
	}
}

export const configEditor = new ConfigEditor();
