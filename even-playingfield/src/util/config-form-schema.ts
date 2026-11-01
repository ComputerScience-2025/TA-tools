/**
 * A UI-neutral description of the config schema.
 *
 * The browser editor renders this tree instead of duplicating the config
 * shape in TypeScript. It is derived from `ConfigSchema` with Zod's JSON
 * Schema conversion, so a field added to the backend appears in the editor
 * without a second edit. Reference widgets and textareas are semantic hints,
 * not presentation.
 */

import { z } from "zod";

import { ConfigSchema } from "./config-schema.ts";
import { cloneConfigValue, isRecord } from "./config-object.ts";
import { errorMessage } from "./errors.ts";
import type { RawConfigObject } from "./config-object.ts";

export type ConfigFieldKind =
    | "object"
    | "record"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "enum"
    | "unsupported";

export type ConfigWidget =
    | "textarea"
    | "password"
    | "provider-reference"
    | "model-reference"
    | "seed"
    | "header-value";

export type ConfigFieldDescriptor = {
    /** Property name, or null for the root/array item/record value. */
    key: string | number | null;
    kind: ConfigFieldKind;
    required: boolean;
    hasDefault: boolean;
    defaultValue?: unknown;
    hidden?: boolean;
    enumValues?: string[];
    minimum?: number;
    maximum?: number;
    title?: string;
    description?: string;
    properties?: ConfigFieldDescriptor[];
    additional?: ConfigFieldDescriptor;
    items?: ConfigFieldDescriptor;
    widget?: ConfigWidget;
};

export type ConfigFormDescriptorResult =
    | { ok: true; descriptor: ConfigFieldDescriptor }
    | { ok: false; message: string };

type JsonSchemaNode = Record<string, unknown>;

const TEXTAREA_PATHS = new Set([
    "analysis_workflows.*.prompt",
    "llm.prompt_replacement.*",
    "testing_workflows.*.test_cases.*.single_run_expected_output.llm_judge_prompt",
    "testing_workflows.*.test_cases.*.interactive_steps.*.expected_output.llm_judge_prompt",
]);

const WIDGET_PATHS: Record<string, ConfigWidget> = {
    "llm.providers.*.api_key": "password",
    "llm.providers.*.headers.*": "header-value",
    "llm.models.*.provider": "provider-reference",
    "llm.models.*.seed": "seed",
    "analysis_workflows.*.model": "model-reference",
    "testing_workflows.*.model": "model-reference",
};

const HIDDEN_PATHS = new Set(["version"]);

function pathPattern(segments: readonly string[]): string {
    return segments.join(".");
}

function widgetFor(segments: readonly string[]): ConfigWidget | undefined {
    const pattern = pathPattern(segments);
    if (TEXTAREA_PATHS.has(pattern)) {
        return "textarea";
    }
    return WIDGET_PATHS[pattern];
}

function resolveNode(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
    let current = node;
    const seen = new Set<string>();
    while (typeof current["$ref"] === "string") {
        const reference = current["$ref"] as string;
        if (seen.has(reference)) {
            break;
        }
        seen.add(reference);
        const match = /^#\/\$defs\/(.+)$/.exec(reference);
        if (match === null) {
            break;
        }
        const definitions = root["$defs"];
        if (!isRecord(definitions)) {
            break;
        }
        const resolved = definitions[match[1]!];
        if (!isRecord(resolved)) {
            break;
        }
        current = resolved;
    }
    return current;
}

function nodeType(node: JsonSchemaNode): string | null {
    const type = node["type"];
    if (typeof type === "string") {
        return type;
    }
    if (Array.isArray(type)) {
        const values = type.filter((entry): entry is string => typeof entry === "string" && entry !== "null");
        return values[0] ?? null;
    }
    return null;
}

function requiredKeys(node: JsonSchemaNode): Set<string> {
    const required = node["required"];
    if (!Array.isArray(required)) {
        return new Set();
    }
    return new Set(required.filter((entry): entry is string => typeof entry === "string"));
}

function schemaDefault(node: JsonSchemaNode): { has: boolean; value?: unknown } {
    if (!Object.prototype.hasOwnProperty.call(node, "default")) {
        return { has: false };
    }
    return { has: true, value: cloneConfigValue(node["default"]) };
}

function walkNode(
    source: JsonSchemaNode,
    root: JsonSchemaNode,
    key: string | number | null,
    required: boolean,
    segments: readonly string[],
): ConfigFieldDescriptor {
    let node = resolveNode(source, root);

    // A nullable union is the only multi-branch shape the config uses. Pick
    // the non-null branch; anything else falls back to a read-only value.
    if (Array.isArray(node["anyOf"])) {
        const options = node["anyOf"].filter((entry): entry is JsonSchemaNode => isRecord(entry));
        const nonNull = options.filter((entry) => nodeType(resolveNode(entry, root)) !== "null");
        if (nonNull.length === 1) {
            node = resolveNode(nonNull[0]!, root);
        }
    }

    const type = nodeType(node);
    const defaults = schemaDefault(node);
    const descriptor: ConfigFieldDescriptor = {
        key,
        kind: "unsupported",
        required,
        hasDefault: defaults.has,
        defaultValue: defaults.value,
    };
    if (typeof node["title"] === "string") {
        descriptor.title = node["title"];
    }
    if (typeof node["description"] === "string") {
        descriptor.description = node["description"];
    }
    if (typeof node["minimum"] === "number") {
        descriptor.minimum = node["minimum"];
    }
    if (typeof node["maximum"] === "number") {
        descriptor.maximum = node["maximum"];
    }
    const widget = widgetFor(segments);
    if (widget !== undefined) {
        descriptor.widget = widget;
    }
    if (HIDDEN_PATHS.has(pathPattern(segments))) {
        descriptor.hidden = true;
    }
    if (pathPattern(segments) === "llm.models.*.seed") {
        // A timestamp default baked into the form would freeze the seed.
        descriptor.hasDefault = false;
        delete descriptor.defaultValue;
    }

    if (type === "object") {
        const properties = node["properties"];
        if (isRecord(properties)) {
            descriptor.kind = "object";
            const requiredProperties = requiredKeys(node);
            descriptor.properties = Object.entries(properties).map(([propertyKey, propertyNode]) => {
                const child = isRecord(propertyNode) ? propertyNode : {};
                return walkNode(
                    child,
                    root,
                    propertyKey,
                    requiredProperties.has(propertyKey),
                    [...segments, propertyKey],
                );
            });
            return descriptor;
        }
        const additional = node["additionalProperties"];
        if (isRecord(additional)) {
            descriptor.kind = "record";
            descriptor.additional = walkNode(additional, root, null, true, [...segments, "*"]);
            return descriptor;
        }
        descriptor.kind = "object";
        descriptor.properties = [];
        return descriptor;
    }

    if (type === "array") {
        descriptor.kind = "array";
        const items = node["items"];
        descriptor.items = isRecord(items)
            ? walkNode(items, root, null, true, [...segments, "*"])
            : { key: null, kind: "unsupported", required: true, hasDefault: false };
        return descriptor;
    }

    if (type === "string") {
        const enumValues = node["enum"];
        if (Array.isArray(enumValues)) {
            descriptor.kind = "enum";
            descriptor.enumValues = enumValues
                .filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number")
                .map((entry) => String(entry));
        } else {
            descriptor.kind = "string";
        }
        return descriptor;
    }

    if (type === "number" || type === "integer") {
        descriptor.kind = type;
        return descriptor;
    }

    if (type === "boolean") {
        descriptor.kind = "boolean";
        return descriptor;
    }

    return descriptor;
}

/** Build the editor descriptor tree, or explain why it could not be built. */
export function buildConfigFormDescriptor(): ConfigFormDescriptorResult {
    try {
        const schema = z.toJSONSchema(ConfigSchema, {
            io: "input",
            unrepresentable: "any",
        }) as JsonSchemaNode;
        return {
            ok: true,
            descriptor: walkNode(schema, schema, null, true, []),
        };
    } catch (error) {
        return {
            ok: false,
            message: errorMessage(error),
        };
    }
}

/** A complete value for a newly added array item or record entry. */
export function createValueForDescriptor(descriptor: ConfigFieldDescriptor): unknown {
    if (descriptor.hasDefault) {
        return cloneConfigValue(descriptor.defaultValue);
    }
    switch (descriptor.kind) {
        case "object": {
            const value: RawConfigObject = {};
            for (const property of descriptor.properties ?? []) {
                if (property.hidden === true) {
                    continue;
                }
                if (!property.required && !property.hasDefault) {
                    continue;
                }
                if (typeof property.key !== "string") {
                    continue;
                }
                value[property.key] = createValueForDescriptor(property);
            }
            return value;
        }
        case "record":
            return {};
        case "array":
            return [];
        case "enum":
            return descriptor.enumValues?.[0] ?? "";
        case "number":
        case "integer":
            return 0;
        case "boolean":
            return false;
        case "string":
            return "";
        case "unsupported":
            return null;
    }
}

/** Descriptor at an absolute config path, following array items and records. */
export function findDescriptor(
    root: ConfigFieldDescriptor,
    path: readonly (string | number)[],
): ConfigFieldDescriptor | null {
    let current: ConfigFieldDescriptor | undefined = root;
    for (const segment of path) {
        if (current === undefined) {
            return null;
        }
        if (typeof segment === "number") {
            current = current.items;
            continue;
        }
        if (current.kind === "object") {
            current = current.properties?.find((property) => property.key === segment);
            continue;
        }
        if (current.kind === "record") {
            current = current.additional;
            continue;
        }
        return null;
    }
    return current ?? null;
}

/**
 * Paths present in a document that the schema does not describe. They are
 * preserved by the editor and listed so a newer config is never silently
 * dropped.
 */
export function collectUnknownConfigPaths(
    value: unknown,
    descriptor: ConfigFieldDescriptor,
    basePath: readonly (string | number)[] = [],
): string[] {
    if (descriptor.kind === "object") {
        if (!isRecord(value)) {
            return [];
        }
        const paths: string[] = [];
        for (const [key, entry] of Object.entries(value)) {
            const property = descriptor.properties?.find((candidate) => candidate.key === key);
            if (property === undefined) {
                paths.push([...basePath, key].join("."));
            } else {
                paths.push(...collectUnknownConfigPaths(entry, property, [...basePath, key]));
            }
        }
        return paths;
    }
    if (descriptor.kind === "record" && descriptor.additional !== undefined) {
        if (!isRecord(value)) {
            return [];
        }
        return Object.entries(value).flatMap(([key, entry]) =>
            collectUnknownConfigPaths(entry, descriptor.additional!, [...basePath, key]),
        );
    }
    if (descriptor.kind === "array" && descriptor.items !== undefined && Array.isArray(value)) {
        return value.flatMap((entry, index) =>
            collectUnknownConfigPaths(entry, descriptor.items!, [...basePath, index]),
        );
    }
    return [];
}
