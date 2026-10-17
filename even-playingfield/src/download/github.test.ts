import { describe, expect, test } from "bun:test";

import { matchRef, parseGithubUrl } from "./github.ts";

describe("parseGithubUrl", () => {
    test("parses a tree URL with a branch and directory", () => {
        const parsed = parseGithubUrl("https://github.com/user/repo/tree/branch_name/dir_name");
        expect(parsed).toEqual({
            owner: "user",
            repo: "repo",
            mode: "tree",
            refAndPath: "branch_name/dir_name",
        });
    });

    test("parses a tree URL pointing at the repo root", () => {
        const parsed = parseGithubUrl("https://github.com/user/repo/tree/main");
        expect(parsed).toEqual({
            owner: "user",
            repo: "repo",
            mode: "tree",
            refAndPath: "main",
        });
    });

    test("parses a blob URL", () => {
        const parsed = parseGithubUrl("https://github.com/user/repo/blob/main/src/a.ts");
        expect(parsed).toEqual({
            owner: "user",
            repo: "repo",
            mode: "blob",
            refAndPath: "main/src/a.ts",
        });
    });

    test("strips a trailing .git from the repo", () => {
        const parsed = parseGithubUrl("https://github.com/user/repo.git/tree/main/x");
        expect(parsed?.repo).toBe("repo");
    });

    test("returns null for non-github hosts", () => {
        expect(parseGithubUrl("https://gitlab.com/user/repo/tree/main")).toBeNull();
    });

    test("returns null for unsupported paths", () => {
        expect(parseGithubUrl("https://github.com/user/repo")).toBeNull();
        expect(parseGithubUrl("https://github.com/user/repo/issues/1")).toBeNull();
    });

    test("returns null for malformed input", () => {
        expect(parseGithubUrl("not a url")).toBeNull();
    });
});

describe("matchRef", () => {
    const refs = ["feature", "feature/foo", "main", "v1.0"];

    test("prefers the longest matching ref so slash branches win", () => {
        expect(matchRef("feature/foo/src", refs)).toEqual({ ref: "feature/foo", path: "src" });
    });

    test("matches an exact ref with an empty path", () => {
        expect(matchRef("main", refs)).toEqual({ ref: "main", path: "" });
    });

    test("matches a shorter ref when the longer one does not apply", () => {
        expect(matchRef("feature/bar", refs)).toEqual({ ref: "feature", path: "bar" });
    });

    test("returns null when no ref matches", () => {
        expect(matchRef("unknown/dir", refs)).toBeNull();
    });
});
