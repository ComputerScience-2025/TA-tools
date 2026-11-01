import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { executeLs, helpText, parseAndExecute } from "./command-handler.ts";
import { toPosixPath } from "./platform/path.ts";
import { BunFileSystem } from "./platform/bun/bun-fs.ts";
import type { CommandContext, CommandTarget } from "./command-handler.ts";
import type { VirtualFileSystem } from "./platform/types.ts";

const FILES = ["epf.toml", "src/program.cs"];

let directory: string;
let fs: BunFileSystem;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "epf-ls-"));
    for (const file of FILES) {
        await mkdir(join(directory, dirname(file)), { recursive: true });
        await writeFile(join(directory, file), "x");
    }
    fs = new BunFileSystem(toPosixPath(directory));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

describe("executeLs", () => {
    test("lists the workspace root with the host header", async () => {
        const result = await executeLs(fs, [], { header: ["Workspace: demo", "Config: epf.toml"] });
        expect(result.kind).toBe("output");
        expect(result.message).toContain("Workspace: demo");
        expect(result.message).toContain("Config: epf.toml");
        expect(result.message).toContain("Listing the workspace root");
        expect(result.message).toContain("src/");
        expect(result.message).toContain("program.cs");
    });

    test("lists a subdirectory", async () => {
        const result = await executeLs(fs, ["src"]);
        expect(result.kind).toBe("output");
        expect(result.message).toContain("Listing 'src'");
        expect(result.message).toContain("program.cs");
        expect(result.message).not.toContain("epf.toml");
    });

    test("lists a single file", async () => {
        const result = await executeLs(fs, ["epf.toml"]);
        expect(result.kind).toBe("output");
        expect(result.message).toContain("Listing 'epf.toml'");
        expect(result.message).toContain("1 file(s), 0 directories");
    });

    test("honours --depth", async () => {
        const shallow = await executeLs(fs, ["--depth", "1"]);
        expect(shallow.message).toContain("src/");
        expect(shallow.message).not.toContain("program.cs");

        const inline = await executeLs(fs, ["--depth=1"]);
        expect(inline.message).not.toContain("program.cs");
    });

    test("reports a missing path without throwing", async () => {
        const result = await executeLs(fs, ["missing"]);
        expect(result.kind).toBe("error");
        expect(result.message).toContain("Not found in the workspace: 'missing'");
    });

    test("rejects malformed arguments", async () => {
        expect((await executeLs(fs, ["--depth", "0"])).kind).toBe("error");
        expect((await executeLs(fs, ["--wat"])).kind).toBe("error");
        expect((await executeLs(fs, ["src", "src"])).kind).toBe("error");
    });

    test("normalizes backslash paths", async () => {
        const result = await executeLs(fs, ["src\\"]);
        expect(result.kind).toBe("output");
        expect(result.message).toContain("Listing 'src'");
    });
});

type FakeState = {
    known: string[];
    inFlight?: string[];
    /** Output filename each workflow slug would produce. */
    outputsBySlug?: Record<string, string>;
    runResult?: { slug: string; runNumber: number; status: "succeeded" | "failed" | "rejected" }[];
};

function fakeEngine(vfs: VirtualFileSystem, state: FakeState): {
    target: CommandTarget;
    clearedRecords: string[];
    runs: (string[] | undefined)[];
} {
    const clearedRecords: string[] = [];
    const runs: (string[] | undefined)[] = [];
    const target: CommandTarget = {
        async runWorkflows(filters) {
            runs.push(filters?.only);
            return state.runResult ?? [{ slug: "first", runNumber: 1, status: "succeeded" }];
        },
        resolveOutputFileNames: (known, slugs) => {
            if (slugs === undefined) {
                return [...known];
            }
            const wanted = slugs
                .map((slug) => state.outputsBySlug?.[slug])
                .filter((name): name is string => name !== undefined);
            return known.filter((name) => wanted.includes(name));
        },
        clearResultFiles(names) {
            clearedRecords.push(...names);
        },
        getStatus: () => ({ inFlight: state.inFlight ?? [], completedFiles: [...state.known] }),
        listWorkflows: () => ({ analysis: ["first"], testing: [] }),
        getFileSystem: () => vfs,
        getConfigSource: () => undefined,
        async listSessions() {
            return [];
        },
        isSessionRecordingEnabled: () => true,
        async reloadConfig() {
            // Nothing to reload in the fake.
        },
    };
    return {
        target,
        clearedRecords,
        runs,
    };
}

describe("parseAndExecute", () => {
    test("status reports the outputs the host knows about", async () => {
        const fake = fakeEngine(fs, { known: ["engine.md"], inFlight: ["first"] });
        const result = await parseAndExecute(fake.target, "status", {
            knownOutputs: () => ["recorded.md"],
        });

        expect(result.kind).toBe("output");
        expect(result.message).toContain("In-flight workflows: first");
        expect(result.message).toContain("Output files: 1");
        expect(result.message).toContain("recorded.md");
        expect(result.message).not.toContain("engine.md");
    });

    test("clear hands the resolved names to the host and reports the count", async () => {
        const fake = fakeEngine(fs, {
            known: ["result.md", "x-result.md-evil.md"],
            outputsBySlug: { first: "result.md", second: "x-result.md-evil.md" },
        });
        const names: string[][] = [];
        const result = await parseAndExecute(fake.target, "clear first", {
            knownOutputs: () => ["result.md", "x-result.md-evil.md"],
            clearOutputs: async (resolved) => {
                names.push([...resolved]);
                return [...resolved];
            },
        });

        expect(names).toEqual([["result.md"]]);
        expect(result.message).toBe("Cleared results: first (1 file(s)).");
        // The host deleted the files; the dispatcher still forgets their records.
        expect(fake.clearedRecords).toEqual(["result.md"]);
    });

    test("clear without a host deletes from the engine's in-memory list", async () => {
        const fake = fakeEngine(fs, { known: ["result.md"] });
        const result = await parseAndExecute(fake.target, "clear", {
            knownOutputs: () => ["result.md"],
        });

        expect(fake.clearedRecords).toEqual(["result.md"]);
        expect(result.message).toBe("Cleared results: all (1 file(s)).");
    });

    test("rerun clears the matching outputs before running", async () => {
        const fake = fakeEngine(fs, {
            known: ["one.md", "two.md"],
            outputsBySlug: { one: "one.md" },
        });
        const result = await parseAndExecute(fake.target, "rerun one", {
            knownOutputs: () => ["one.md", "two.md"],
            clearOutputs: async (resolved) => [...resolved],
        });

        expect(fake.clearedRecords).toEqual(["one.md"]);
        expect(fake.runs).toEqual([["one"]]);
        expect(result.message).toContain("Succeeded: 1");
    });

    test("ls prints the host header", async () => {
        const fake = fakeEngine(fs, { known: [] });
        const result = await parseAndExecute(fake.target, "ls", {
            lsHeader: ["Workspace: demo", "Config: epf.toml"],
        });

        expect(result.message).toContain("Workspace: demo");
        expect(result.message).toContain("Config: epf.toml");
    });

    test("help text names every command and varies by host", () => {
        const cli = helpText("cli");
        const web = helpText("web");

        expect(cli).toContain("Shut down the program");
        expect(web).toContain("close the browser tab");
        for (const command of ["run", "rerun", "clear", "status", "list", "ls", "chat", "reload", "help", "exit", "quit"]) {
            expect(cli).toContain(command);
        }
    });

    test("exit uses the host message", async () => {
        const fake = fakeEngine(fs, { known: [] });
        const context: CommandContext = { exitMessage: "Close the tab instead." };
        expect((await parseAndExecute(fake.target, "exit", context)).message).toBe("Close the tab instead.");
        expect((await parseAndExecute(fake.target, "quit")).message).toBe("Shutting down...");
    });

    test("rejects unknown commands", async () => {
        const fake = fakeEngine(fs, { known: [] });
        const result = await parseAndExecute(fake.target, "wat");
        expect(result.kind).toBe("error");
        expect(result.message).toContain("Unknown command: 'wat'");
    });
});

