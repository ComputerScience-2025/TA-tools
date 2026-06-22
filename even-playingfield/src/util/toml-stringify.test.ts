import { describe, expect, test } from "bun:test";

import { stringifyToml } from "./toml-stringify.ts";


describe("stringifyToml", () => {
    describe("round-trip through Bun.TOML.parse", () => {
        test("Simple string without newlines", () => {
            const obj = { k: "hello world" };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe("hello world");
        });

        test("Multi-line string with leading newline", () => {
            const value = "\nYou are a TA.\nGrade this.\n";
            const out = stringifyToml({ prompt: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.prompt).toBe(value);
        });

        test("Multi-line string without leading newline", () => {
            const value = "Analyze the following:\ncode1\ncode2\n";
            const out = stringifyToml({ prompt: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.prompt).toBe(value);
        });

        test("String with no trailing newline", () => {
            const value = "line1\nline2";
            const out = stringifyToml({ prompt: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.prompt).toBe(value);
        });

        test("Empty string", () => {
            const out = stringifyToml({ k: "" });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe("");
        });

        test("String with tabs", () => {
            const value = "col1\tcol2\nrow2\tcol2";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("String with carriage returns", () => {
            const value = "line1\r\nline2\rline3";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("String with backslash", () => {
            const value = "path\\to\\file\nsecond";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Nested table with multi-line value", () => {
            const obj = {
                llm: {
                    prompt_replacement: {
                        role: "You are a TA.\nGrade this.\nBe fair.",
                        format: "short",
                    },
                },
            };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            const llm = parsed.llm as Record<string, unknown>;
            const pr = llm.prompt_replacement as Record<string, unknown>;
            expect(pr.role).toBe("You are a TA.\nGrade this.\nBe fair.");
            expect(pr.format).toBe("short");
        });

        test("Dotted key with multi-line value", () => {
            const obj = {
                llm: {
                    providers: {
                        openrouter: {
                            api_key: "key1\nkey2",
                            sdk: "openai",
                        },
                    },
                },
            };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            const llm = parsed.llm as Record<string, unknown>;
            const providers = llm.providers as Record<string, unknown>;
            const or = providers.openrouter as Record<string, unknown>;
            expect(or.api_key).toBe("key1\nkey2");
            expect(or.sdk).toBe("openai");
        });

        test("Array of tables with multi-line prompts", () => {
            const obj = {
                analysis_workflows: [
                    { slug: "a", prompt: "Analyze a:\nstep1", output_filename: "a.md", model: "g", runs: 1 },
                    { slug: "b", prompt: "Analyze b:\nstep1", output_filename: "b.md", model: "g", runs: 1 },
                ],
            };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            const workflows = parsed.analysis_workflows as Array<Record<string, unknown>>;
            expect(workflows[0]!.prompt).toBe("Analyze a:\nstep1");
            expect(workflows[1]!.prompt).toBe("Analyze b:\nstep1");
        });

        test("Realistic epf config shape", () => {
            const obj = {
                version: 5,
                llm: {
                    prompt_replacement: {
                        role: "\nYou are a TA.\nGrade this submission.\nBe fair.",
                    },
                },
                analysis_workflows: [{
                    slug: "assignment1",
                    prompt: "\nAnalyze the code.\nBe thorough.",
                    output_filename: "feedback.md",
                    model: "general_analysis",
                    runs: 1,
                }],
            };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            const llm = parsed.llm as Record<string, unknown>;
            const pr = llm.prompt_replacement as Record<string, unknown>;
            expect(pr.role).toBe("\nYou are a TA.\nGrade this submission.\nBe fair.");
            const workflows = parsed.analysis_workflows as Array<Record<string, unknown>>;
            expect(workflows[0]!.prompt).toBe("\nAnalyze the code.\nBe thorough.");
            expect(parsed.version).toBe(5);
        });
    });

    describe("multi-line string format", () => {
        test("Multi-line string emitted as triple-quoted block", () => {
            const out = stringifyToml({ prompt: "line1\nline2" });
            expect(out).toContain('prompt = """');
            expect(out).toContain('"""');
        });

        test("Single-line string stays as basic string", () => {
            const out = stringifyToml({ k: "simple" });
            expect(out).toContain('k = "simple"');
            expect(out).not.toContain('"""');
        });

        test("No leading newline inserted after opening delimiter", () => {
            // Bun.TOML.parse does NOT trim the leading newline after """
            // (unlike the TOML spec), so emitting one would corrupt the value.
            const value = "first\nsecond";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
            // The opening delimiter should be immediately followed by "first",
            // not by a newline.
            expect(out).toContain('"""first');
        });
    });

    describe("trailing double-quotes", () => {
        test("One trailing quote round-trips", () => {
            const value = "Hello\nWorld\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Two trailing quotes round-trip", () => {
            const value = "Hello\nWorld\"\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Three trailing quotes round-trip", () => {
            const value = "Hello\nWorld\"\"\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Four trailing quotes round-trip", () => {
            const value = "Hello\nWorld\"\"\"\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Five trailing quotes round-trip", () => {
            const value = "Hello\nWorld\"\"\"\"\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Escaped backslash followed by quote round-trips", () => {
            // Input contains a literal backslash followed by a quote: \"
            const value = "Hello\nWorld\\\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Escaped backslash followed by four quotes round-trips", () => {
            const value = "Hello\nWorld\\\"\"\"\"";
            const out = stringifyToml({ k: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.k).toBe(value);
        });

        test("Prompt ending with quoted text", () => {
            // Realistic case: a prompt that ends with a quoted phrase.
            const value = "Analyze the code.\nRespond with \"yes\".";
            const out = stringifyToml({ prompt: value });
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.prompt).toBe(value);
        });
    });

    describe("non-string values", () => {
        test("Numbers and booleans", () => {
            const obj = { count: 42, ratio: 3.14, flag: true, off: false };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            expect(parsed.count).toBe(42);
            expect(parsed.ratio).toBe(3.14);
            expect(parsed.flag).toBe(true);
            expect(parsed.off).toBe(false);
        });

        test("Arrays of strings keep newlines escaped (not multi-line)", () => {
            // Strings inside arrays are intentionally NOT converted to
            // multi-line blocks — see the file header for rationale.
            const obj = { setup_commands: ["echo setup1", "echo setup2\nline2"] };
            const out = stringifyToml(obj);
            const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
            const arr = parsed.setup_commands as string[];
            expect(arr[0]).toBe("echo setup1");
            expect(arr[1]).toBe("echo setup2\nline2");
            // The multi-line element should stay as a basic string (no """).
            expect(out).not.toContain('"""');
        });

        test("Empty object", () => {
            const out = stringifyToml({});
            // smol-toml emits nothing for an empty object, plus a trailing newline.
            expect(out.trim()).toBe("");
        });
    });
});
