import { describe, expect, test } from "bun:test";

import {
    OUTPUT_FILENAME_PLACEHOLDERS,
    describeOutputFilenamePlaceholders,
    outputFilenamePattern,
    resolveOutputFilename,
} from "./output-filename.ts";

const VALUES = {
    slug: "analysis",
    model: "(test--model)",
    seed: "42",
    run: "3",
};

describe("output filename placeholders", () => {
    test("resolves every supported placeholder", () => {
        const name = resolveOutputFilename("[slug]-[model]-[seed]-[run].epf.md", VALUES);
        expect(name).toBe("analysis-(test--model)-42-3.epf.md");
    });

    test("leaves unknown bracket text intact", () => {
        expect(resolveOutputFilename("[slug]-[other].epf.md", VALUES)).toBe("analysis-[other].epf.md");
    });

    test("matches generated names and rejects overlapping prefixes", () => {
        const template = "[slug]-[model]-[seed]-[run].epf.md";
        const pattern = outputFilenamePattern(template);
        const name = resolveOutputFilename(template, VALUES);
        expect(pattern.test(name)).toBe(true);
        expect(pattern.test(`${name}-evil.md`)).toBe(false);
        expect(pattern.test("analysis-other.md")).toBe(false);
    });

    test("escapes literal regex characters", () => {
        const template = "result.(final)-[seed].md";
        const pattern = outputFilenamePattern(template);
        expect(pattern.test(resolveOutputFilename(template, VALUES))).toBe(true);
        expect(pattern.test("resultXfinal-42.md")).toBe(false);
    });

    test("describes every supported placeholder", () => {
        const help = describeOutputFilenamePlaceholders();
        for (const placeholder of OUTPUT_FILENAME_PLACEHOLDERS) {
            expect(help).toContain(`[${placeholder}]`);
        }
    });
});
