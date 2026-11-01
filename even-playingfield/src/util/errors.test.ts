import { describe, expect, test } from "bun:test";

import { errorMessage } from "./errors.ts";

describe("util/errors", () => {
    test("reads Error.message", () => {
        expect(errorMessage(new Error("boom"))).toBe("boom");
    });

    test("stringifies non-Error values", () => {
        expect(errorMessage("plain text")).toBe("plain text");
        expect(errorMessage(42)).toBe("42");
        expect(errorMessage(undefined)).toBe("undefined");
    });

    test("keeps a subclass message", () => {
        class ConfigError extends Error {}
        expect(errorMessage(new ConfigError("bad config"))).toBe("bad config");
    });
});
