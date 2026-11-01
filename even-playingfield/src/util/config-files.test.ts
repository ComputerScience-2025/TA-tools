import { describe, expect, test } from "bun:test";

import {
    configFileNameProblem,
    configRelativePathProblem,
    isTomlFileName,
    normalizeConfigFileName,
    normalizeConfigRelativePath,
} from "./config-files.ts";

describe("config file names", () => {
    test("appends the TOML extension once", () => {
        expect(normalizeConfigFileName("epf")).toBe("epf.toml");
        expect(normalizeConfigFileName("epf.toml")).toBe("epf.toml");
        expect(normalizeConfigFileName("  graded.TOML ")).toBe("graded.TOML");
    });

    test("rejects flat names that cannot be a library file", () => {
        expect(configFileNameProblem("")).not.toBeNull();
        expect(configFileNameProblem("  ")).not.toBeNull();
        expect(configFileNameProblem(".hidden")).not.toBeNull();
        expect(configFileNameProblem("eval/epf.toml")).not.toBeNull();
        expect(configFileNameProblem("eval\\epf.toml")).not.toBeNull();
        expect(configFileNameProblem("epf.toml")).toBeNull();
    });

    test("keeps a workspace-relative config inside the workspace", () => {
        expect(configRelativePathProblem("eval/epf.toml")).toBeNull();
        expect(configRelativePathProblem("/etc/epf.toml")).not.toBeNull();
        expect(configRelativePathProblem("C:/epf.toml")).not.toBeNull();
        expect(configRelativePathProblem("../epf.toml")).not.toBeNull();
        expect(configRelativePathProblem("eval/../../epf.toml")).not.toBeNull();
        expect(configRelativePathProblem("eval/.hidden.toml")).not.toBeNull();
    });

    test("normalizes a relative path without moving it between folders", () => {
        expect(normalizeConfigRelativePath("eval/epf")).toBe("eval/epf.toml");
        expect(normalizeConfigRelativePath("eval//epf.toml")).toBe("eval/epf.toml");
        expect(normalizeConfigRelativePath("epf.TOML")).toBe("epf.TOML");
    });

    test("recognizes TOML file names case-insensitively", () => {
        expect(isTomlFileName("epf.toml")).toBe(true);
        expect(isTomlFileName("EPF.TOML")).toBe(true);
        expect(isTomlFileName("epf.json")).toBe(false);
    });
});
