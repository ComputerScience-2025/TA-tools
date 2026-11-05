import { describe, expect, test } from "bun:test";

import {
    joinS3Key,
    normalizeS3Prefix,
    publicS3ObjectUrl,
    resolveS3Settings,
    s3ObjectUrl,
} from "./s3.ts";
import type { S3Settings } from "./s3.ts";

const S3_SETTINGS: S3Settings = {
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    bucket: "ta-configs",
    prefix: "",
    accessKeyID: "key-id",
    secretAccessKey: "secret-key",
    addressingStyle: "path",
};

describe("S3 settings", () => {
    test("reads the reduced B2/R2 settings and infers the region", () => {
        const values: Record<string, string> = {
            EPF_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
            EPF_S3_BUCKET: "ta-configs",
            EPF_S3_ACCESS_KEY_ID: "key-id",
            EPF_S3_SECRET_ACCESS_KEY: "secret-key",
            EPF_S3_ADDRESSING_STYLE: "path",
        };
        const result = resolveS3Settings({ get: (name) => values[name] });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.settings.region).toBe("us-west-004");
            expect(result.settings.bucket).toBe("ta-configs");
            expect(result.settings.addressingStyle).toBe("path");
        }
    });

    test("falls back to auto for R2 and other custom endpoints", () => {
        const values: Record<string, string> = {
            EPF_S3_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
            EPF_S3_BUCKET: "ta-configs",
            EPF_S3_ACCESS_KEY_ID: "key-id",
            EPF_S3_SECRET_ACCESS_KEY: "secret-key",
            EPF_S3_ADDRESSING_STYLE: "path",
        };
        const result = resolveS3Settings({ get: (name) => values[name] });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.settings.region).toBe("auto");
        }
    });

    test("reads the explicit addressing style", () => {
        const values: Record<string, string> = {
            EPF_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
            EPF_S3_BUCKET: "ta-configs",
            EPF_S3_ACCESS_KEY_ID: "key-id",
            EPF_S3_SECRET_ACCESS_KEY: "secret-key",
            EPF_S3_ADDRESSING_STYLE: "virtual",
        };
        const result = resolveS3Settings({ get: (name) => values[name] });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.settings.addressingStyle).toBe("virtual");
        }
    });

    test("rejects an unknown addressing style", () => {
        const values: Record<string, string> = {
            EPF_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
            EPF_S3_BUCKET: "ta-configs",
            EPF_S3_ACCESS_KEY_ID: "key-id",
            EPF_S3_SECRET_ACCESS_KEY: "secret-key",
            EPF_S3_ADDRESSING_STYLE: "auto",
        };
        const result = resolveS3Settings({ get: (name) => values[name] });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain("EPF_S3_ADDRESSING_STYLE");
        }
    });

    test("normalizes and applies the optional key prefix", () => {
        expect(normalizeS3Prefix(" /configs/ ")).toEqual({ ok: true, prefix: "configs" });
        expect(normalizeS3Prefix("configs\\epf")).toEqual({ ok: true, prefix: "configs/epf" });
        expect(joinS3Key("configs", "epf.toml")).toBe("configs/epf.toml");
        expect(joinS3Key("", "epf.toml")).toBe("epf.toml");
    });

    test("rejects a prefix that escapes the bucket", () => {
        expect(normalizeS3Prefix("../configs").ok).toBe(false);
    });

    test("names every missing variable", () => {
        const result = resolveS3Settings({ get: () => undefined });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.missing).toEqual([
                "EPF_S3_ENDPOINT",
                "EPF_S3_BUCKET",
                "EPF_S3_ACCESS_KEY_ID",
                "EPF_S3_SECRET_ACCESS_KEY",
                "EPF_S3_ADDRESSING_STYLE",
            ]);
        }
    });

    test("rejects a non-URL endpoint", () => {
        const result = resolveS3Settings({
            get: (name) => (name === "EPF_S3_ENDPOINT" ? "s3.example.com" : "x"),
        });
        expect(result.ok).toBe(false);
    });
});

describe("S3 object URLs", () => {
    test("uses path-style URLs when requested", () => {
        expect(s3ObjectUrl(S3_SETTINGS, "configs/epf.toml")).toBe(
            "https://s3.us-west-004.backblazeb2.com/ta-configs/configs/epf.toml",
        );
        expect(s3ObjectUrl({ ...S3_SETTINGS, endpoint: "https://abc.r2.cloudflarestorage.com" }, "epf.toml"))
            .toBe("https://abc.r2.cloudflarestorage.com/ta-configs/epf.toml");
    });

    test("uses virtual-hosted URLs when requested", () => {
        expect(s3ObjectUrl({ ...S3_SETTINGS, addressingStyle: "virtual" }, "configs/epf.toml")).toBe(
            "https://ta-configs.s3.us-west-004.backblazeb2.com/configs/epf.toml",
        );
        expect(s3ObjectUrl({
            ...S3_SETTINGS,
            endpoint: "https://s3.us-east-1.amazonaws.com",
            region: "us-east-1",
            addressingStyle: "virtual",
        }, "configs/epf.toml")).toBe(
            "https://ta-configs.s3.us-east-1.amazonaws.com/configs/epf.toml",
        );
    });

    test("encodes key segments but keeps folder separators", () => {
        expect(s3ObjectUrl(S3_SETTINGS, "shared configs/epf.toml")).toBe(
            "https://s3.us-west-004.backblazeb2.com/ta-configs/shared%20configs/epf.toml",
        );
    });

    test("builds a public URL only when a base is configured", () => {
        expect(publicS3ObjectUrl(S3_SETTINGS, "configs/epf.toml", undefined)).toBeNull();
        expect(publicS3ObjectUrl(S3_SETTINGS, "configs/epf.toml", "https://configs.example.com/"))
            .toBe("https://configs.example.com/configs/epf.toml");
    });
});
