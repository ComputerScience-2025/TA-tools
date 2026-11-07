import { describe, expect, test } from "bun:test";

import { sharedConfigUrlFromHash, stripSharedConfigHash } from "./shared-config.ts";

describe("sharedConfigUrlFromHash", () => {
    test("reads the primary parameter", () => {
        expect(sharedConfigUrlFromHash("#?EPF_CONFIG_URL=https%3A%2F%2Fexample.com%2Fepf.toml")).toBe(
            "https://example.com/epf.toml"
        );
    });

    test("reads the alias and ignores the hash route", () => {
        expect(sharedConfigUrlFromHash("#config?config=https://example.com/a.toml")).toBe(
            "https://example.com/a.toml"
        );
    });

    test("rejects non-http values", () => {
        expect(sharedConfigUrlFromHash("#?EPF_CONFIG_URL=javascript%3Aalert(1)")).toBeNull();
        expect(sharedConfigUrlFromHash("#?EPF_CONFIG_URL=file%3A%2F%2Ftmp%2Fepf.toml")).toBeNull();
    });

    test("returns null when the hash has no query or no config", () => {
        expect(sharedConfigUrlFromHash("")).toBeNull();
        expect(sharedConfigUrlFromHash("#source")).toBeNull();
        expect(sharedConfigUrlFromHash("#?foo=bar")).toBeNull();
    });
});

describe("stripSharedConfigHash", () => {
    test("removes the config params and keeps the rest", () => {
        expect(stripSharedConfigHash("#config?EPF_CONFIG_URL=https%3A%2F%2Fexample.com%2Fa.toml&x=1")).toBe(
            "config?x=1"
        );
    });

    test("drops the query when it becomes empty", () => {
        expect(stripSharedConfigHash("#?config=https://example.com/a.toml")).toBe("");
    });

    test("returns null when there is nothing to strip", () => {
        expect(stripSharedConfigHash("")).toBeNull();
        expect(stripSharedConfigHash("#source")).toBeNull();
        expect(stripSharedConfigHash("#source?x=1")).toBeNull();
    });
});
