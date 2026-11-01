import { describe, expect, test } from "bun:test";

import { formatBytes } from "./format.ts";

describe("util/format", () => {
    test("formats small values in bytes", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(1023)).toBe("1023 B");
    });

    test("switches units at 1024", () => {
        expect(formatBytes(1024)).toBe("1.0 KB");
        expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
        expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TB");
    });

    test("uses whole numbers from 10 units upwards", () => {
        expect(formatBytes(10 * 1024)).toBe("10 KB");
        expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
        expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
    });
});
