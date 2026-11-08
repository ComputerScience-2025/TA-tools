import { describe, expect, test } from "bun:test";

import { sharedConfigLink, sharedConfigUrlFromHash, stripSharedConfigHash } from "./shared-config.ts";

describe("sharedConfigLink", () => {
    test("builds a hash link that parses back to the same URL", () => {
        const link = sharedConfigLink("https://example.com/epf.toml", "https://tools.example.test");
        expect(link).toBe(
            "https://tools.example.test/apps/epf/config/environment#?EPF_CONFIG_URL=https%3A%2F%2Fexample.com%2Fepf.toml"
        );
        expect(sharedConfigUrlFromHash(link!.slice(link!.indexOf("#")))).toBe(
            "https://example.com/epf.toml"
        );
    });

    test("trims the URL before encoding it", () => {
        expect(sharedConfigLink("  https://example.com/a.toml  ", "https://tools.example.test")).toBe(
            "https://tools.example.test/apps/epf/config/environment#?EPF_CONFIG_URL=https%3A%2F%2Fexample.com%2Fa.toml"
        );
    });

    test("rejects missing and non-http values", () => {
        expect(sharedConfigLink("", "https://tools.example.test")).toBeNull();
        expect(sharedConfigLink("javascript:alert(1)", "https://tools.example.test")).toBeNull();
        expect(sharedConfigLink("file:///tmp/epf.toml", "https://tools.example.test")).toBeNull();
    });
});

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
