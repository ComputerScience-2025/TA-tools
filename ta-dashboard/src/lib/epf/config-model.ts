import { basenamePath, relativePath } from "$epf/platform/path.ts";
import { describeOutputFilenamePlaceholders } from "$epf/util/output-filename.ts";

import type { ConfigPath, RawConfigObject } from "$epf/util/config-object.ts";
import type { ConfigFieldDescriptor } from "$epf/util/config-form-schema.ts";
import type { ConfigSource } from "$epf/util/config-loader.ts";

/** Stable key for drafts and the DOM. */
export function sourceKey(source: ConfigSource | null): string {
	if (source === null) {
		return "new";
	}
	switch (source.kind) {
		case "path":
			return `path:${source.path}`;
		case "url":
			return `url:${source.url}`;
		case "inline":
			return `inline:${source.label}`;
	}
}

export function sourceFileName(source: ConfigSource | null): string {
	if (source === null) {
		return "epf.toml";
	}
	switch (source.kind) {
		case "path":
			return basenamePath(source.path);
		case "url": {
			try {
				const path = new URL(source.url).pathname;
				const name = path.slice(path.lastIndexOf("/") + 1);
				return name.length > 0 ? name : "epf.toml";
			} catch {
				return "epf.toml";
			}
		}
		case "inline": {
			const imported = source.label.startsWith("imported: ")
				? source.label.slice("imported: ".length).trim()
				: "";
			return imported.length > 0 ? imported : "epf.toml";
		}
	}
}

export function isPathWithin(path: string, root: string): boolean {
	const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
	return normalizedRoot.length > 0 && (path === normalizedRoot || path.startsWith(`${normalizedRoot}/`));
}

export function sourceDisplayLabel(
	source: ConfigSource | null,
	homeDir: string,
	workspacePath: string | null
): string {
	if (source === null) {
		return "New config";
	}
	switch (source.kind) {
		case "path":
			if (homeDir.length > 0 && isPathWithin(source.path, homeDir)) {
				return `Library · ${basenamePath(source.path)}`;
			}
			if (workspacePath !== null && isPathWithin(source.path, workspacePath)) {
				return `Workspace · ${relativePath(workspacePath, source.path)}`;
			}
			return source.path;
		case "url":
			return `URL · ${source.url}`;
		case "inline":
			return "Session only";
	}
}

export function sourceIsFile(source: ConfigSource | null): source is ConfigSource & { kind: "path" } {
	return source !== null && source.kind === "path";
}

export function pathKey(path: ConfigPath): string {
	return path
		.map((segment) => String(segment).replace(/[^a-zA-Z0-9_-]/g, "_"))
		.join(".");
}

// --- Labels and help -------------------------------------------------------

const ACRONYMS: Record<string, string> = {
	api: "API",
	llm: "LLM",
	url: "URL",
	sdk: "SDK",
	ui: "UI",
	webui: "Web UI",
	toml: "TOML",
	id: "ID",
};

export function humanizeKey(key: string): string {
	return key
		.split("_")
		.filter((part) => part.length > 0)
		.map((part) => ACRONYMS[part.toLowerCase()] ?? `${part[0]!.toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

const ENUM_LABELS: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	xhigh: "Extra high",
	none: "None",
	diff: "Diff",
	full: "Full",
	webui: "Web UI",
	local: "Local",
};

export function enumLabel(value: string): string {
	return ENUM_LABELS[value.toLowerCase()] ?? humanizeKey(value);
}

function matchesPattern(path: ConfigPath, pattern: string): boolean {
	const parts = pattern.split(".");
	if (parts.length !== path.length) {
		return false;
	}
	return parts.every((part, index) => part === "*" || String(path[index]) === part);
}

const FIELD_LABELS: { pattern: string; label: string }[] = [
	{ pattern: "version", label: "Config version" },
	{ pattern: "output_viewing", label: "Output viewing" },
	{ pattern: "llm", label: "LLM" },
	{ pattern: "llm.providers", label: "Providers" },
	{ pattern: "llm.models", label: "Models" },
	{ pattern: "llm.prompt_replacement", label: "Prompt replacements" },
	{ pattern: "analysis_workflows", label: "Analysis workflows" },
	{ pattern: "testing_workflows", label: "Testing workflows" },
	{ pattern: "analysis_workflows.*.input_files_searches", label: "Input file searches" },
	{ pattern: "analysis_workflows.*.input_files_searches.*", label: "File search" },
	{ pattern: "testing_workflows.*.test_cases", label: "Test cases" },
	{ pattern: "testing_workflows.*.test_cases.*", label: "Test case" },
	{ pattern: "testing_workflows.*.test_cases.*.single_run_expected_output", label: "Expected output" },
	{ pattern: "testing_workflows.*.test_cases.*.interactive_steps", label: "Interactive steps" },
	{ pattern: "testing_workflows.*.test_cases.*.interactive_steps.*", label: "Interaction" },
	{ pattern: "testing_workflows.*.test_cases.*.interactive_steps.*.expected_output", label: "Expected output" },
	{ pattern: "analysis_workflows.*.prompt", label: "Prompt" },
	{ pattern: "llm.providers.*.api_key", label: "API key" },
	{ pattern: "llm.providers.*.sdk", label: "SDK" },
	{ pattern: "llm.providers.*.headers", label: "Headers" },
	{ pattern: "llm.models.*.model_name", label: "Model name" },
	{ pattern: "llm.models.*.provider", label: "Provider" },
	{ pattern: "llm.models.*.max_completion_tokens", label: "Max completion tokens" },
	{ pattern: "llm.models.*.top_p", label: "Top P" },
	{ pattern: "llm.models.*.max_retries", label: "Max retries" },
	{ pattern: "llm.models.*.retry_delay_ms", label: "Retry delay (ms)" },
	{ pattern: "output_viewing.webui_base_url", label: "Web UI base URL" },
	{ pattern: "output_viewing.api_port", label: "API port" },
	{ pattern: "testing_workflows.*.test_cases.*.single_run_expected_output.llm_judge_input_mode", label: "LLM judge input mode" },
	{ pattern: "testing_workflows.*.test_cases.*.single_run_expected_output.llm_judge_prompt", label: "LLM judge prompt" },
];

export function fieldLabel(path: ConfigPath, descriptor: ConfigFieldDescriptor): string {
	if (typeof descriptor.key === "number") {
		return `Item ${descriptor.key + 1}`;
	}
	for (const entry of FIELD_LABELS) {
		if (matchesPattern(path, entry.pattern)) {
			return entry.label;
		}
	}
	if (typeof descriptor.key === "string") {
		return humanizeKey(descriptor.key);
	}
	if (path.length > 0) {
		return humanizeKey(String(path[path.length - 1]));
	}
	return "Config";
}

const OUTPUT_FILENAME_HELP = describeOutputFilenamePlaceholders();

const FIELD_HELP: { pattern: string; help: string }[] = [
	{
		pattern: "llm.models.*.seed",
		help: "Leave unset to use a fresh timestamp for every run. A fixed seed makes runs reproducible."
	},
	{
		pattern: "llm.providers.*.api_key",
		help: "Sent directly to the provider. Saving this config stores the key in this browser."
	},
	{
		pattern: "llm.providers.*.headers",
		help: "Extra request headers. Anthropic needs \"anthropic-dangerous-direct-browser-access: true\" in a browser."
	},
	{
		pattern: "analysis_workflows.*.model",
		help: "Must name a model defined under LLM → Models."
	},
	{
		pattern: "testing_workflows.*.model",
		help: "Must name a model defined under LLM → Models."
	},
	{
		pattern: "analysis_workflows.*.output_filename",
		help: OUTPUT_FILENAME_HELP
	},
	{
		pattern: "testing_workflows.*.output_filename",
		help: OUTPUT_FILENAME_HELP
	},
	{
		pattern: "analysis_workflows.*.input_files_searches.*.search_directory",
		help: "Relative to the active workspace."
	},
	{
		pattern: "analysis_workflows.*.input_files_searches.*.excluded_files",
		help: "Paths or globs to leave out of this search."
	},
	{
		pattern: "testing_workflows.*.test_cases.*.work_directory",
		help: "Relative to the active workspace."
	},
	{
		pattern: "output_viewing.api_port",
		help: "0 picks a random available port (used by local mode)."
	},
	{
		pattern: "output_viewing.mode",
		help: "Web UI mode is the browser-friendly default. Testing workflows still need the CLI."
	},
];

export function fieldHelp(path: ConfigPath): string | null {
	for (const entry of FIELD_HELP) {
		if (matchesPattern(path, entry.pattern)) {
			return entry.help;
		}
	}
	return null;
}

export function arrayItemLabel(
	path: ConfigPath,
	item: unknown,
	index: number
): string {
	const collection = path[path.length - 1];
	if (typeof item === "string") {
		return item.length > 0 ? item : `Item ${index + 1}`;
	}
	if (typeof item === "number" || typeof item === "boolean") {
		return String(item);
	}
	if (typeof item === "object" && item !== null) {
		const record = item as Record<string, unknown>;
		if (collection === "analysis_workflows" || collection === "testing_workflows") {
			return typeof record["slug"] === "string" && record["slug"].length > 0
				? record["slug"]
				: `Workflow ${index + 1}`;
		}
		if (collection === "test_cases") {
			return typeof record["name"] === "string" && record["name"].length > 0
				? record["name"]
				: `Test case ${index + 1}`;
		}
		if (collection === "input_files_searches") {
			return typeof record["file_glob"] === "string" && record["file_glob"].length > 0
				? record["file_glob"]
				: `Search ${index + 1}`;
		}
		if (collection === "interactive_steps") {
			return typeof record["input"] === "string" && record["input"].length > 0
				? record["input"]
				: `Step ${index + 1}`;
		}
	}
	return `Item ${index + 1}`;
}

// --- New / duplicated entries ---------------------------------------------

export function suggestRecordKey(
	recordPath: ConfigPath,
	existing: readonly string[]
): string {
	const last = recordPath[recordPath.length - 1];
	const base = last === "providers"
		? "provider"
		: last === "models"
			? "model"
			: last === "prompt_replacement"
				? "placeholder"
				: last === "headers"
					? "header"
					: "entry";
	return uniqueName(existing, base);
}

function uniqueName(existing: readonly string[], base: string): string {
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

function firstModelName(raw: RawConfigObject): string {
	const models = raw["llm"];
	if (typeof models === "object" && models !== null) {
		const map = (models as Record<string, unknown>)["models"];
		if (typeof map === "object" && map !== null) {
			const names = Object.keys(map);
			if (names.length > 0) {
				return names[0]!;
			}
		}
	}
	return "general_analysis";
}

function existingSlugs(raw: RawConfigObject, collection: "analysis_workflows" | "testing_workflows"): string[] {
	const value = raw[collection];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((entry) => {
		if (typeof entry === "object" && entry !== null) {
			const slug = (entry as Record<string, unknown>)["slug"];
			return typeof slug === "string" ? [slug] : [];
		}
		return [];
	});
}

function existingOutputNames(raw: RawConfigObject, collection: "analysis_workflows" | "testing_workflows"): string[] {
	const value = raw[collection];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((entry) => {
		if (typeof entry === "object" && entry !== null) {
			const name = (entry as Record<string, unknown>)["output_filename"];
			return typeof name === "string" ? [name] : [];
		}
		return [];
	});
}

function copyFileName(name: string, existing: readonly string[]): string {
	const suffix = "-copy";
	const lower = name.toLowerCase();
	const base = lower.endsWith(".epf.md")
		? `${name.slice(0, -7)}${suffix}.epf.md`
		: (() => {
			const dot = name.lastIndexOf(".");
			return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
		})();
	if (!existing.includes(base)) {
		return base;
	}
	const extIndex = base.toLowerCase().endsWith(".epf.md") ? base.length - 7 : base.lastIndexOf(".");
	const stem = extIndex > 0 ? base.slice(0, extIndex) : base;
	const extension = extIndex > 0 ? base.slice(extIndex) : "";
	let suffixNumber = 2;
	while (existing.includes(`${stem}_${suffixNumber}${extension}`)) {
		suffixNumber += 1;
	}
	return `${stem}_${suffixNumber}${extension}`;
}

/** Field values to apply when adding an array item. */
export function newArrayItemOverrides(path: ConfigPath, raw: RawConfigObject): Record<string, unknown> {
	const collection = path[path.length - 1];
	if (collection === "analysis_workflows" || collection === "testing_workflows") {
		return {
			slug: uniqueName(existingSlugs(raw, collection), collection === "analysis_workflows"
				? "analysis-workflow"
				: "testing-workflow"),
			model: firstModelName(raw),
			output_filename: "[slug].epf.md",
		};
	}
	if (collection === "test_cases") {
		const cases = raw["testing_workflows"];
		const names: string[] = [];
		if (Array.isArray(cases)) {
			for (const workflow of cases) {
				if (typeof workflow === "object" && workflow !== null) {
					const testCases = (workflow as Record<string, unknown>)["test_cases"];
					if (Array.isArray(testCases)) {
						for (const testCase of testCases) {
							if (typeof testCase === "object" && testCase !== null) {
								const name = (testCase as Record<string, unknown>)["name"];
								if (typeof name === "string") {
									names.push(name);
								}
							}
						}
					}
				}
			}
		}
		const index = names.length + 1;
		return { name: uniqueName(names, `Test Case ${index}`) };
	}
	if (collection === "input_files_searches") {
		return { file_glob: "*" };
	}
	return {};
}

/** Field values to apply when duplicating an array item. */
export function duplicateArrayItemOverrides(
	path: ConfigPath,
	item: unknown,
	raw: RawConfigObject
): Record<string, unknown> {
	const collection = path[path.length - 1];
	if (collection !== "analysis_workflows" && collection !== "testing_workflows") {
		if (collection === "test_cases" && typeof item === "object" && item !== null) {
			const name = (item as Record<string, unknown>)["name"];
			return {
				name: typeof name === "string" && name.length > 0 ? `${name} copy` : "Test case copy"
			};
		}
		return {};
	}
	if (typeof item !== "object" || item === null) {
		return {};
	}
	const record = item as Record<string, unknown>;
	const slug = typeof record["slug"] === "string" && record["slug"].length > 0 ? record["slug"] : "workflow";
	const output = typeof record["output_filename"] === "string" && record["output_filename"].length > 0
		? record["output_filename"]
		: "[slug].epf.md";
	return {
		slug: uniqueName(existingSlugs(raw, collection), `${slug}-copy`),
		output_filename: copyFileName(output, existingOutputNames(raw, collection))
	};
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

export function downloadTextFile(filename: string, text: string): void {
	const blob = new Blob([text], { type: "application/toml;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readTextFile(file: File): Promise<string> {
	return await file.text();
}
