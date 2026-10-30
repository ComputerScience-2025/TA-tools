/**
 * Placeholders supported in workflow `output_filename` templates.
 *
 * This list is the single source of truth for filename placeholders: the
 * workflow resolves names with it, the engine builds its output matcher from
 * it, and the config editor renders its help text from it. Adding a new
 * placeholder here updates all three.
 */
export const OUTPUT_FILENAME_PLACEHOLDERS = ["slug", "model", "seed", "run"] as const;

export type OutputFilenamePlaceholder = (typeof OUTPUT_FILENAME_PLACEHOLDERS)[number];

export type OutputFilenameValues = Readonly<Record<OutputFilenamePlaceholder, string>>;

function placeholderToken(placeholder: OutputFilenamePlaceholder): string {
    return `[${placeholder}]`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Substitute every supported placeholder; unknown bracket text is left intact. */
export function resolveOutputFilename(template: string, values: OutputFilenameValues): string {
    let resolved = template;
    for (const placeholder of OUTPUT_FILENAME_PLACEHOLDERS) {
        resolved = resolved.replaceAll(placeholderToken(placeholder), values[placeholder]);
    }
    return resolved;
}

/**
 * Build an anchored matcher for a configured output filename. Every supported
 * placeholder is treated as a wildcard, which distinguishes workflows whose
 * literal filename prefixes overlap.
 */
export function outputFilenamePattern(template: string): RegExp {
    const tokens = new Set(OUTPUT_FILENAME_PLACEHOLDERS.map((placeholder) => placeholderToken(placeholder)));
    const placeholderSuffix = OUTPUT_FILENAME_PLACEHOLDERS.map((placeholder) => escapeRegExp(placeholder)).join("|");
    const splitPattern = new RegExp(`(\\[(?:${placeholderSuffix})\\])`);
    const body = template
        .split(splitPattern)
        .map((part) => tokens.has(part) ? ".+" : escapeRegExp(part))
        .join("");
    return new RegExp(`^${body}$`);
}

/** Human-readable helper text generated from the supported placeholder list. */
export function describeOutputFilenamePlaceholders(): string {
    const tokens = OUTPUT_FILENAME_PLACEHOLDERS.map((placeholder) => placeholderToken(placeholder));
    if (tokens.length === 0) {
        return "No output filename placeholders are supported.";
    }
    if (tokens.length === 1) {
        return `Supports the ${tokens[0]} placeholder.`;
    }
    const last = tokens[tokens.length - 1]!;
    return `Supports the ${tokens.slice(0, -1).join(", ")} and ${last} placeholders.`;
}
