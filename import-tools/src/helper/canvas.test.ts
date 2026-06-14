import { describe, expect, test } from "bun:test";

import {CanvasHelper} from "./canvas.ts";

describe("CanvasHelper", () => {
    test("Preserve normal filename", () => {
        expect(CanvasHelper.fixFileName("ABC.cs")).toBe("ABC.cs");
    });
    test("Remove numeric suffix", () => {
        expect(CanvasHelper.fixFileName("ABC-1.cs")).toBe("ABC.cs");
    });
    test("Remove UUID suffix", () => {
        expect(CanvasHelper.fixFileName("UnitTest1-80a8d60a-75b2-4fda-a291-b72a36395bd9.cs")).toBe("UnitTest1.cs");
    });
    test("Remove UUID suffix with pure-numeric tail", () => {
        expect(CanvasHelper.fixFileName("UnitTest1-00000000-0000-4000-8000-000000000000.cs")).toBe("UnitTest1.cs");
    });
    test("Remove UUID suffix (v1)", () => {
        expect(CanvasHelper.fixFileName("Report-550e8400-e29b-11d4-a716-446655440000.cs")).toBe("Report.cs");
    });
    test("Remove UUID suffix (v3)", () => {
        expect(CanvasHelper.fixFileName("Report-550e8400-e29b-31d4-a716-446655440000.cs")).toBe("Report.cs");
    });
    test("Remove UUID suffix (v5)", () => {
        expect(CanvasHelper.fixFileName("Report-550e8400-e29b-51d4-a716-446655440000.cs")).toBe("Report.cs");
    });
    test("Remove UUID suffix with .cpp extension", () => {
        expect(CanvasHelper.fixFileName("Report-6ba7b810-9dad-11d1-80b4-00c04fd430c8.cpp")).toBe("Report.cpp");
    });
    test("Remove UUID suffix with .h extension", () => {
        expect(CanvasHelper.fixFileName("Header-6ba7b810-9dad-11d1-80b4-00c04fd430c8.h")).toBe("Header.h");
    });
    test("Remove UUID suffix variant 8", () => {
        expect(CanvasHelper.fixFileName("F-00000000-0000-4000-8000-000000000000.cs")).toBe("F.cs");
    });
    test("Remove UUID suffix variant 9", () => {
        expect(CanvasHelper.fixFileName("F-00000000-0000-4000-9000-000000000000.cs")).toBe("F.cs");
    });
    test("Remove UUID suffix variant a", () => {
        expect(CanvasHelper.fixFileName("F-00000000-0000-4000-a000-000000000000.cs")).toBe("F.cs");
    });
    test("Remove UUID suffix variant b", () => {
        expect(CanvasHelper.fixFileName("F-00000000-0000-4000-b000-000000000000.cs")).toBe("F.cs");
    });
    test("Remove uppercase UUID suffix", () => {
        expect(CanvasHelper.fixFileName("F-80A8D60A-75B2-4FDA-A291-B72A36395BD9.cs")).toBe("F.cs");
    });
    test("Remove mixed-case UUID suffix", () => {
        expect(CanvasHelper.fixFileName("F-80a8D60A-75B2-4fda-A291-b72A36395BD9.cs")).toBe("F.cs");
    });
    test("Remove UUID suffix with underscore in base name", () => {
        expect(CanvasHelper.fixFileName("My_File-80a8d60a-75b2-4fda-a291-b72a36395bd9.cs")).toBe("My_File.cs");
    });
    test("Remove numeric suffix with underscore in base name", () => {
        expect(CanvasHelper.fixFileName("My_File-1.cs")).toBe("My_File.cs");
    });
    test("Remove multi-digit numeric suffix", () => {
        expect(CanvasHelper.fixFileName("ABC-12.cs")).toBe("ABC.cs");
    });
    test("Preserve non-UUID dash suffix (letter tail)", () => {
        expect(CanvasHelper.fixFileName("abc-def.cs")).toBe("abc-def.cs");
    });
    test("Preserve single-letter dash suffix", () => {
        expect(CanvasHelper.fixFileName("Class-A.cs")).toBe("Class-A.cs");
    });
    test("Preserve invalid variant nibble (7) with hex tail", () => {
        expect(CanvasHelper.fixFileName("F-80a8d60a-75b2-4fda-7291-b72a36395bd9.cs")).toBe("F-80a8d60a-75b2-4fda-7291-b72a36395bd9.cs");
    });
    test("Preserve invalid version nibble (6) with hex tail", () => {
        expect(CanvasHelper.fixFileName("F-80a8d60a-75b2-6fda-a291-b72a36395bd9.cs")).toBe("F-80a8d60a-75b2-6fda-a291-b72a36395bd9.cs");
    });
    test("Preserve invalid version nibble (0) with hex tail", () => {
        expect(CanvasHelper.fixFileName("F-80a8d60a-75b2-0fda-a291-b72a36395bd9.cs")).toBe("F-80a8d60a-75b2-0fda-a291-b72a36395bd9.cs");
    });
    test("Digit branch strips pure-numeric tail in 5-group pattern (invalid variant)", () => {
        expect(CanvasHelper.fixFileName("F-00000000-0000-4000-7000-000000000000.cs")).toBe("F-00000000-0000-4000-7000.cs");
    });
    test("Digit branch strips pure-numeric tail in 5-group pattern (invalid version)", () => {
        expect(CanvasHelper.fixFileName("F-00000000-0000-6000-8000-000000000000.cs")).toBe("F-00000000-0000-6000-8000.cs");
    });
    test("Preserve too-short last UUID group with hex tail", () => {
        expect(CanvasHelper.fixFileName("F-12345678-1234-1234-a291-1234567890a.cs")).toBe("F-12345678-1234-1234-a291-1234567890a.cs");
    });
    test("Preserve too-short first UUID group with hex tail", () => {
        expect(CanvasHelper.fixFileName("F-1234567-1234-1234-a291-b72a36395bd9.cs")).toBe("F-1234567-1234-1234-a291-b72a36395bd9.cs");
    });
    test("Digit branch strips trailing numeric group in all-short pattern", () => {
        expect(CanvasHelper.fixFileName("F-1-2-3-4-5.cs")).toBe("F-1-2-3-4.cs");
    });
    test("Remove UUID suffix with uppercase extension (.CS)", () => {
        expect(CanvasHelper.fixFileName("UnitTest1-80a8d60a-75b2-4fda-a291-b72a36395bd9.CS")).toBe("UnitTest1.CS");
    });
    test("Remove UUID suffix with mixed-case extension (.Cpp)", () => {
        expect(CanvasHelper.fixFileName("Report-6ba7b810-9dad-11d1-80b4-00c04fd430c8.Cpp")).toBe("Report.Cpp");
    });
    test("Remove UUID suffix with uppercase extension (.H)", () => {
        expect(CanvasHelper.fixFileName("Header-6ba7b810-9dad-11d1-80b4-00c04fd430c8.H")).toBe("Header.H");
    });
    test("Remove numeric suffix with uppercase extension (.CS)", () => {
        expect(CanvasHelper.fixFileName("ABC-1.CS")).toBe("ABC.CS");
    });
    test("Remove multi-digit numeric suffix with uppercase extension", () => {
        expect(CanvasHelper.fixFileName("ABC-12.CS")).toBe("ABC.CS");
    });
});
