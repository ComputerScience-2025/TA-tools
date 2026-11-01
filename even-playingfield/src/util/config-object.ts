/**
 * Pure operations on an editable config document.
 *
 * The browser editor keeps the parsed TOML object as its source of truth and
 * mutates it through these helpers. Nothing here validates or applies a
 * config; that stays in `config-loader.ts`, so the editor and the engine use
 * exactly the same rules.
 */

import { CURRENT_CONFIG_VERSION } from "./config-schema.ts";
import { detectConfigVersion, migrateToCurrent, migrationSteps } from "./config-migrations.ts";
import { validateConfigObject } from "./config-loader.ts";
import { createDefaultConfigDocument } from "./config-defaults.ts";
import { stringifyToml } from "./toml-stringify.ts";
import { errorMessage } from "./errors.ts";
import type { ConfigValidation } from "./config-loader.ts";
import type { MigrationStep } from "./config-migrations.ts";
import type { TomlCodec } from "../platform/types.ts";

export type RawConfigObject = Record<string, unknown>;
export type ConfigPath = readonly (string | number)[];

export type ParsedConfigDocument = {
    raw: RawConfigObject;
    version: number;
};

export type ConfigDocumentParseResult =
    | { ok: true; document: ParsedConfigDocument }
    | { ok: false; message: string };

export type MigratedConfigDocument = {
    raw: RawConfigObject;
    fromVersion: number;
    steps: MigrationStep[];
};

export function isRecord(value: unknown): value is RawConfigObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-copy plain objects and arrays, leaving everything else by reference. */
export function cloneConfigValue<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneConfigValue(entry)) as T;
    }
    if (isRecord(value)) {
        const copy: RawConfigObject = {};
        for (const [key, entry] of Object.entries(value)) {
            copy[key] = cloneConfigValue(entry);
        }
        return copy as T;
    }
    return value;
}

/** Parse TOML text without checking the schema or version. */
export function parseConfigDocument(text: string, toml: TomlCodec): ConfigDocumentParseResult {
    if (text.trim().length === 0) {
        return { ok: false, message: "The config file is empty." };
    }
    try {
        const raw = toml.parse(text) as RawConfigObject;
        return { ok: true, document: { raw, version: detectConfigVersion(raw) } };
    } catch (error) {
        const message = errorMessage(error);
        return { ok: false, message };
    }
}

/** Apply the registered migrations to a parsed document. */
export function migrateConfigDocument(raw: RawConfigObject): MigratedConfigDocument {
    const fromVersion = detectConfigVersion(raw);
    if (fromVersion >= CURRENT_CONFIG_VERSION) {
        return { raw: cloneConfigValue(raw), fromVersion, steps: [] };
    }
    const steps = migrationSteps(fromVersion);
    const migrated = migrateToCurrent(cloneConfigValue(raw));
    return { raw: migrated, fromVersion, steps };
}

/** Validate with the exact gate the engine uses. */
export function validateConfigDocument(raw: RawConfigObject, label: string): ConfigValidation {
    return validateConfigObject(raw, label);
}

/** TOML text exactly as Save would write it. */
export function serializeConfigDocument(raw: RawConfigObject): string {
    return stringifyToml(canonicalizeConfigDocument(raw));
}

export function createDefaultDocument(): RawConfigObject {
    return createDefaultConfigDocument();
}

// --- Canonical field order -------------------------------------------------

const TOP_LEVEL_ORDER = ["version", "output_viewing", "sessions", "llm", "analysis_workflows", "testing_workflows"];
const LLM_ORDER = ["providers", "models", "prompt_replacement"];
const OUTPUT_VIEWING_ORDER = ["mode", "api_port", "webui_base_url"];
const PROVIDER_ORDER = ["sdk", "endpoint", "api_key", "headers"];
const MODEL_ORDER = [
    "provider",
    "model_name",
    "seed",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "reasoning_effort",
    "max_retries",
    "retry_delay_ms",
];
const ANALYSIS_WORKFLOW_ORDER = [
    "slug",
    "model",
    "runs",
    "input_files_searches",
    "output_filename",
    "prompt",
];
const TESTING_WORKFLOW_ORDER = [
    "slug",
    "model",
    "runs",
    "output_filename",
    "setup_commands",
    "test_cases",
    "cleanup_commands",
];
const TEST_CASE_ORDER = [
    "name",
    "work_directory",
    "single_run_command",
    "single_run_expected_output",
    "interactive_steps",
];
const FILE_SEARCH_ORDER = ["file_glob", "search_directory", "excluded_files"];
const EXPECTED_OUTPUT_ORDER = [
    "prefix_strip_string",
    "postfix_strip_string",
    "substring",
    "llm_judge_input_mode",
    "llm_judge_prompt",
];

function orderRecord(source: RawConfigObject, preferred: readonly string[]): RawConfigObject {
    const ordered: RawConfigObject = {};
    for (const key of preferred) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            ordered[key] = source[key];
        }
    }
    for (const key of Object.keys(source)) {
        if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
            ordered[key] = source[key];
        }
    }
    return ordered;
}

function orderOptionalRecord(value: unknown, preferred: readonly string[]): unknown {
    return isRecord(value) ? orderRecord(value, preferred) : value;
}

function orderRecordValues(value: unknown, preferred: readonly string[]): unknown {
    if (!isRecord(value)) {
        return value;
    }
    const ordered: RawConfigObject = {};
    for (const [key, entry] of Object.entries(value)) {
        ordered[key] = orderOptionalRecord(entry, preferred);
    }
    return ordered;
}

function orderArrayItems(value: unknown, order: (entry: unknown) => unknown): unknown {
    return Array.isArray(value) ? value.map(order) : value;
}

function orderExpectedOutput(value: unknown): unknown {
    return orderOptionalRecord(value, EXPECTED_OUTPUT_ORDER);
}

function orderFileSearch(value: unknown): unknown {
    return orderOptionalRecord(value, FILE_SEARCH_ORDER);
}

function orderTestCase(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }
    const ordered = orderRecord(value, TEST_CASE_ORDER);
    ordered["single_run_expected_output"] = orderExpectedOutput(ordered["single_run_expected_output"]);
    if (Array.isArray(ordered["interactive_steps"])) {
        ordered["interactive_steps"] = ordered["interactive_steps"].map((step) => {
            if (!isRecord(step)) {
                return step;
            }
            const orderedStep = orderRecord(step, ["input", "expected_output"]);
            orderedStep["expected_output"] = orderExpectedOutput(orderedStep["expected_output"]);
            return orderedStep;
        });
    }
    return ordered;
}

function orderAnalysisWorkflow(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }
    const ordered = orderRecord(value, ANALYSIS_WORKFLOW_ORDER);
    ordered["input_files_searches"] = orderArrayItems(ordered["input_files_searches"], orderFileSearch);
    return ordered;
}

function orderTestingWorkflow(value: unknown): unknown {
    if (!isRecord(value)) {
        return value;
    }
    const ordered = orderRecord(value, TESTING_WORKFLOW_ORDER);
    ordered["test_cases"] = orderArrayItems(ordered["test_cases"], orderTestCase);
    return ordered;
}

/**
 * Put known fields in a stable, readable order. Unknown fields are preserved
 * after the known ones so a config from a newer build is never truncated by
 * the editor.
 */
export function canonicalizeConfigDocument(raw: RawConfigObject): RawConfigObject {
    const cloned = cloneConfigValue(raw);
    const ordered = orderRecord(cloned, TOP_LEVEL_ORDER);
    ordered["output_viewing"] = orderOptionalRecord(ordered["output_viewing"], OUTPUT_VIEWING_ORDER);

    if (isRecord(ordered["llm"])) {
        const llm = orderRecord(ordered["llm"], LLM_ORDER);
        llm["providers"] = orderRecordValues(llm["providers"], PROVIDER_ORDER);
        llm["models"] = orderRecordValues(llm["models"], MODEL_ORDER);
        ordered["llm"] = llm;
    }

    ordered["analysis_workflows"] = orderArrayItems(ordered["analysis_workflows"], orderAnalysisWorkflow);
    ordered["testing_workflows"] = orderArrayItems(ordered["testing_workflows"], orderTestingWorkflow);
    return ordered;
}

// --- Path access -----------------------------------------------------------

function accessChild(container: unknown, key: string | number): unknown {
    if (typeof key === "number") {
        return Array.isArray(container) ? container[key] : undefined;
    }
    return isRecord(container) ? container[key] : undefined;
}

function assignChild(container: unknown, key: string | number, value: unknown): void {
    if (typeof key === "number") {
        if (!Array.isArray(container)) {
            throw new Error(`Expected an array at ${String(key)}.`);
        }
        container[key] = value;
        return;
    }
    if (!isRecord(container)) {
        throw new Error(`Expected an object at ${key}.`);
    }
    container[key] = value;
}

function childExists(container: unknown, key: string | number): boolean {
    if (typeof key === "number") {
        return Array.isArray(container) && key >= 0 && key < container.length;
    }
    return isRecord(container) && Object.prototype.hasOwnProperty.call(container, key);
}

export function hasAtPath(root: RawConfigObject, path: ConfigPath): boolean {
    let current: unknown = root;
    for (const key of path) {
        if (!childExists(current, key)) {
            return false;
        }
        current = accessChild(current, key);
    }
    return true;
}

export function getAtPath(root: RawConfigObject, path: ConfigPath): unknown {
    let current: unknown = root;
    for (const key of path) {
        current = accessChild(current, key);
        if (current === undefined) {
            return undefined;
        }
    }
    return current;
}

/** Set a value, creating missing parent objects/arrays along the way. */
export function setAtPath(root: RawConfigObject, path: ConfigPath, value: unknown): void {
    if (path.length === 0) {
        throw new Error("Cannot replace the root config object.");
    }
    let current: unknown = root;
    for (let index = 0; index < path.length - 1; index += 1) {
        const key = path[index]!;
        let child = accessChild(current, key);
        if (child === undefined || child === null || typeof child !== "object") {
            const nextKey = path[index + 1]!;
            child = typeof nextKey === "number" ? [] : {};
            assignChild(current, key, child);
        }
        current = child;
    }
    assignChild(current, path[path.length - 1]!, value);
}

export function deleteAtPath(root: RawConfigObject, path: ConfigPath): void {
    if (path.length === 0) {
        throw new Error("Cannot delete the root config object.");
    }
    const parent = getAtPath(root, path.slice(0, -1));
    const key = path[path.length - 1]!;
    if (typeof key === "number") {
        if (!Array.isArray(parent)) {
            return;
        }
        parent.splice(key, 1);
        return;
    }
    if (isRecord(parent)) {
        delete parent[key];
    }
}

export function getArrayAt(root: RawConfigObject, path: ConfigPath): unknown[] | null {
    const value = getAtPath(root, path);
    return Array.isArray(value) ? value : null;
}

function ensureArray(root: RawConfigObject, path: ConfigPath): unknown[] {
    const value = getAtPath(root, path);
    if (Array.isArray(value)) {
        return value;
    }
    const created: unknown[] = [];
    setAtPath(root, path, created);
    return created;
}

export function appendArrayItem(root: RawConfigObject, path: ConfigPath, value: unknown): void {
    ensureArray(root, path).push(value);
}

export function insertArrayItem(root: RawConfigObject, path: ConfigPath, index: number, value: unknown): void {
    const array = ensureArray(root, path);
    const clamped = Math.max(0, Math.min(index, array.length));
    array.splice(clamped, 0, value);
}

export function deleteArrayItem(root: RawConfigObject, path: ConfigPath, index: number): void {
    const array = getArrayAt(root, path);
    if (array === null || index < 0 || index >= array.length) {
        return;
    }
    array.splice(index, 1);
}

export function moveArrayItem(root: RawConfigObject, path: ConfigPath, from: number, to: number): boolean {
    const array = getArrayAt(root, path);
    if (array === null || from < 0 || from >= array.length || to < 0 || to >= array.length || from === to) {
        return false;
    }
    const [item] = array.splice(from, 1);
    array.splice(to, 0, item);
    return true;
}

export function getRecordAt(root: RawConfigObject, path: ConfigPath): RawConfigObject | null {
    const value = getAtPath(root, path);
    return isRecord(value) ? value : null;
}

function ensureRecord(root: RawConfigObject, path: ConfigPath): RawConfigObject {
    const value = getAtPath(root, path);
    if (isRecord(value)) {
        return value;
    }
    const created: RawConfigObject = {};
    setAtPath(root, path, created);
    return created;
}

export function addRecordEntry(
    root: RawConfigObject,
    path: ConfigPath,
    key: string,
    value: unknown,
): void {
    const record = ensureRecord(root, path);
    if (Object.prototype.hasOwnProperty.call(record, key)) {
        throw new Error(`"${key}" already exists.`);
    }
    record[key] = value;
}

export function deleteRecordEntry(root: RawConfigObject, path: ConfigPath, key: string): void {
    const record = getRecordAt(root, path);
    if (record === null) {
        return;
    }
    delete record[key];
}

/** Rename a key while keeping its position in the object. */
export function renameRecordEntry(
    root: RawConfigObject,
    path: ConfigPath,
    oldKey: string,
    newKey: string,
): void {
    const record = getRecordAt(root, path);
    if (record === null) {
        throw new Error("The entry does not exist.");
    }
    if (!Object.prototype.hasOwnProperty.call(record, oldKey)) {
        throw new Error(`"${oldKey}" does not exist.`);
    }
    if (oldKey === newKey) {
        return;
    }
    if (Object.prototype.hasOwnProperty.call(record, newKey)) {
        throw new Error(`"${newKey}" already exists.`);
    }
    const renamed: RawConfigObject = {};
    for (const [key, value] of Object.entries(record)) {
        renamed[key === oldKey ? newKey : key] = value;
    }
    setAtPath(root, path, renamed);
}

export function moveRecordEntry(
    root: RawConfigObject,
    path: ConfigPath,
    key: string,
    offset: -1 | 1,
): boolean {
    const record = getRecordAt(root, path);
    if (record === null) {
        return false;
    }
    const entries = Object.entries(record);
    const index = entries.findIndex(([entryKey]) => entryKey === key);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= entries.length) {
        return false;
    }
    const [entry] = entries.splice(index, 1);
    entries.splice(target, 0, entry!);
    const reordered: RawConfigObject = {};
    for (const [entryKey, value] of entries) {
        reordered[entryKey] = value;
    }
    setAtPath(root, path, reordered);
    return true;
}

export function uniqueKey(existing: Iterable<string>, base: string): string {
    const used = new Set(existing);
    if (!used.has(base)) {
        return base;
    }
    let suffix = 2;
    while (used.has(`${base}_${suffix}`)) {
        suffix += 1;
    }
    return `${base}_${suffix}`;
}

// --- Reference-aware renames ----------------------------------------------

function stringField(record: RawConfigObject, key: string): string | null {
    const value = record[key];
    return typeof value === "string" ? value : null;
}

/** Names of models that point at this provider key. */
export function providerKeyReferences(root: RawConfigObject, key: string): string[] {
    const models = getRecordAt(root, ["llm", "models"]);
    if (models === null) {
        return [];
    }
    const references: string[] = [];
    for (const [modelName, model] of Object.entries(models)) {
        if (isRecord(model) && stringField(model, "provider") === key) {
            references.push(modelName);
        }
    }
    return references;
}

function workflowReferences(root: RawConfigObject, key: string): string[] {
    const references: string[] = [];
    for (const collection of ["analysis_workflows", "testing_workflows"]) {
        const workflows = getAtPath(root, [collection]);
        if (!Array.isArray(workflows)) {
            continue;
        }
        workflows.forEach((workflow, index) => {
            if (isRecord(workflow) && stringField(workflow, "model") === key) {
                const slug = stringField(workflow, "slug");
                references.push(`${collection}[${index}]${slug !== null ? ` (${slug})` : ""}`);
            }
        });
    }
    return references;
}

/** Names of workflows that point at this model key. */
export function modelKeyReferences(root: RawConfigObject, key: string): string[] {
    return workflowReferences(root, key);
}

/** Rename a provider key and every `llm.models.*.provider` that used it. */
export function renameProviderKey(root: RawConfigObject, oldKey: string, newKey: string): void {
    renameRecordEntry(root, ["llm", "providers"], oldKey, newKey);
    const models = getRecordAt(root, ["llm", "models"]);
    if (models === null) {
        return;
    }
    for (const model of Object.values(models)) {
        if (isRecord(model) && stringField(model, "provider") === oldKey) {
            model["provider"] = newKey;
        }
    }
}

/** Rename a model key and every workflow that referenced it. */
export function renameModelKey(root: RawConfigObject, oldKey: string, newKey: string): void {
    renameRecordEntry(root, ["llm", "models"], oldKey, newKey);
    for (const collection of ["analysis_workflows", "testing_workflows"]) {
        const workflows = getAtPath(root, [collection]);
        if (!Array.isArray(workflows)) {
            continue;
        }
        for (const workflow of workflows) {
            if (isRecord(workflow) && stringField(workflow, "model") === oldKey) {
                workflow["model"] = newKey;
            }
        }
    }
}
