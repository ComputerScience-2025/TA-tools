import { describe, expect, test } from "bun:test";

import {
    basenamePath,
    dirnamePath,
    extnamePath,
    isAbsolutePath,
    joinPath,
    normalizePath,
    relativePath,
    resolvePath,
    toPosixPath,
} from "./path.ts";

describe("platform/path", () => {
    test("toPosixPath converts Windows separators", () => {
        expect(toPosixPath("C:\\Users\\pan\\file.cs")).toBe("C:/Users/pan/file.cs");
        expect(toPosixPath("a/b")).toBe("a/b");
    });

    test("isAbsolutePath", () => {
        expect(isAbsolutePath("/epf/workspaces")).toBe(true);
        expect(isAbsolutePath("C:/Users/pan")).toBe(true);
        expect(isAbsolutePath("src/Program.cs")).toBe(false);
        expect(isAbsolutePath("./src")).toBe(false);
    });

    test("normalizePath collapses dot segments and duplicate slashes", () => {
        expect(normalizePath("/a//b/./c")).toBe("/a/b/c");
        expect(normalizePath("/a/b/../c")).toBe("/a/c");
        expect(normalizePath("a/b/../../c")).toBe("c");
        expect(normalizePath("a/b/../../../c")).toBe("../c");
        expect(normalizePath("/")).toBe("/");
        expect(normalizePath(".")).toBe(".");
        expect(normalizePath("/a/b/")).toBe("/a/b");
        expect(normalizePath("C:/a/./b")).toBe("C:/a/b");
    });

    test("joinPath", () => {
        expect(joinPath("src", "Program.cs")).toBe("src/Program.cs");
        expect(joinPath(".", "foo.cs")).toBe("foo.cs");
        expect(joinPath("/epf", "workspaces", "ws-1")).toBe("/epf/workspaces/ws-1");
        expect(joinPath("", "a")).toBe("a");
    });

    test("resolvePath resolves relative paths against a base", () => {
        expect(resolvePath("/epf", "src/a.cs")).toBe("/epf/src/a.cs");
        expect(resolvePath("/epf", "/other/a.cs")).toBe("/other/a.cs");
        expect(resolvePath("/epf", ".")).toBe("/epf");
    });

    test("dirnamePath / basenamePath / extnamePath", () => {
        expect(dirnamePath("/epf/src/a.cs")).toBe("/epf/src");
        expect(dirnamePath("a.cs")).toBe(".");
        expect(dirnamePath("/")).toBe("/");
        expect(basenamePath("/epf/src/a.cs")).toBe("a.cs");
        expect(basenamePath("/epf/src/")).toBe("src");
        expect(extnamePath("/epf/src/a.cs")).toBe(".cs");
        expect(extnamePath("/epf/src/.gitignore")).toBe("");
        expect(extnamePath("/epf/src/noext")).toBe("");
    });

    test("relativePath", () => {
        expect(relativePath("/epf/a", "/epf/a/b/c.cs")).toBe("b/c.cs");
        expect(relativePath("/epf/a/b", "/epf/a")).toBe("..");
        expect(relativePath("/epf/a", "/epf/a")).toBe(".");
        expect(relativePath("/x", "/y/z")).toBe("../y/z");
    });
});
