import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { executeLs } from "./command-handler.ts";
import { toPosixPath } from "./platform/path.ts";
import { BunFileSystem } from "./platform/bun/bun-fs.ts";

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
