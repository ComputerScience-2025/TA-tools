/**
 * S3-compatible object storage for saving a single config file.
 *
 * The AWS SDK signs the request and handles the endpoint style: custom
 * endpoints (Backblaze B2, Cloudflare R2, MinIO) use path-style URLs, while
 * `*.amazonaws.com` endpoints use virtual-hosted URLs. The SDK is imported
 * lazily so the rest of the app does not pay for it until a save is requested.
 */

import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";

import {
    S3_ACCESS_KEY_ID_ENV_VAR,
    S3_ADDRESSING_STYLE_ENV_VAR,
    S3_BUCKET_ENV_VAR,
    S3_ENDPOINT_ENV_VAR,
    S3_PREFIX_ENV_VAR,
    S3_REGION_ENV_VAR,
    S3_SECRET_ACCESS_KEY_ENV_VAR,
} from "./env-vars.ts";
import { errorMessage } from "./errors.ts";

const S3_TIMEOUT_MS = 20_000;
const DEFAULT_S3_REGION = "auto";

export type S3AddressingStyle = "path" | "virtual";

export type S3Settings = {
    endpoint: string;
    region: string;
    bucket: string;
    /** Normalized key prefix; empty means the bucket root. */
    prefix: string;
    accessKeyID: string;
    secretAccessKey: string;
    addressingStyle: S3AddressingStyle;
};

export type S3EnvReader = {
    get(name: string): string | undefined;
};

export type S3SettingsResult =
    | { ok: true; settings: S3Settings }
    | { ok: false; missing: string[]; message: string };

export type S3ObjectInfo = {
    exists: boolean;
    etag: string | null;
};

type S3Sdk = typeof import("@aws-sdk/client-s3");

let sdkPromise: Promise<S3Sdk> | null = null;

function loadSdk(): Promise<S3Sdk> {
    sdkPromise ??= import("@aws-sdk/client-s3");
    return sdkPromise;
}

function readEnv(env: S3EnvReader, name: string): string {
    return env.get(name)?.trim() ?? "";
}

/** Normalize an object-key prefix, or explain why it is unusable. */
export function normalizeS3Prefix(value: string): { ok: true; prefix: string } | { ok: false; message: string } {
    const normalized = value.trim().replace(/\\/g, "/");
    if (normalized.length === 0) {
        return { ok: true, prefix: "" };
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    if (segments.includes("..")) {
        return { ok: false, message: `${S3_PREFIX_ENV_VAR} cannot contain '..' segments.` };
    }
    return { ok: true, prefix: segments.join("/") };
}

/** Full object key: configured prefix plus the relative key. */
export function joinS3Key(prefix: string, key: string): string {
    return prefix.length === 0 ? key : `${prefix}/${key}`;
}

/** Derive the signing region from common endpoints when it is not set. */
function inferRegion(endpoint: string): string {
    try {
        const host = new URL(endpoint).hostname;
        const b2 = /^s3\.([^.]+)\.backblazeb2\.com$/.exec(host);
        if (b2 !== null) {
            return b2[1]!;
        }
        const aws = /^s3\.([^.]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
        if (aws !== null) {
            return aws[1]!;
        }
        if (host === "s3.amazonaws.com") {
            return "us-east-1";
        }
    } catch {
        // An invalid endpoint is reported by resolveS3Settings below.
    }
    return DEFAULT_S3_REGION;
}

/** Read S3 settings from the platform environment. */
export function resolveS3Settings(env: S3EnvReader): S3SettingsResult {
    const endpoint = readEnv(env, S3_ENDPOINT_ENV_VAR);
    const bucket = readEnv(env, S3_BUCKET_ENV_VAR);
    const accessKeyID = readEnv(env, S3_ACCESS_KEY_ID_ENV_VAR);
    const secretAccessKey = readEnv(env, S3_SECRET_ACCESS_KEY_ENV_VAR);
    const region = readEnv(env, S3_REGION_ENV_VAR) || inferRegion(endpoint);
    const addressing = readEnv(env, S3_ADDRESSING_STYLE_ENV_VAR).toLowerCase();
    const prefix = normalizeS3Prefix(readEnv(env, S3_PREFIX_ENV_VAR));

    const missing: string[] = [];
    if (endpoint.length === 0) {
        missing.push(S3_ENDPOINT_ENV_VAR);
    }
    if (bucket.length === 0) {
        missing.push(S3_BUCKET_ENV_VAR);
    }
    if (accessKeyID.length === 0) {
        missing.push(S3_ACCESS_KEY_ID_ENV_VAR);
    }
    if (secretAccessKey.length === 0) {
        missing.push(S3_SECRET_ACCESS_KEY_ENV_VAR);
    }
    if (addressing.length === 0) {
        missing.push(S3_ADDRESSING_STYLE_ENV_VAR);
    }
    if (missing.length > 0) {
        return {
            ok: false,
            missing,
            message: `S3 is not configured. Set ${missing.join(", ")} in Config → Environment.`,
        };
    }

    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        return {
            ok: false,
            missing: [],
            message: `${S3_ENDPOINT_ENV_VAR} must be an http(s) URL, for example https://s3.us-west-004.backblazeb2.com.`,
        };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return {
            ok: false,
            missing: [],
            message: `${S3_ENDPOINT_ENV_VAR} must use http or https.`,
        };
    }
    if (addressing !== "path" && addressing !== "virtual") {
        return {
            ok: false,
            missing: [],
            message: `${S3_ADDRESSING_STYLE_ENV_VAR} must be "path" or "virtual".`,
        };
    }
    if (!prefix.ok) {
        return { ok: false, missing: [], message: prefix.message };
    }

    return {
        ok: true,
        settings: {
            endpoint,
            region,
            bucket,
            prefix: prefix.prefix,
            accessKeyID,
            secretAccessKey,
            addressingStyle: addressing,
        },
    };
}

/** Encode one S3 key segment. */
function encodeS3Segment(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/** Encode a key while preserving its folder separators. */
export function encodeS3Key(key: string): string {
    const segments = key.split("/").filter((segment) => segment.length > 0);
    return segments.map(encodeS3Segment).join("/");
}

function endpointURL(settings: S3Settings): URL {
    const trimmed = settings.endpoint.trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`${S3_ENDPOINT_ENV_VAR} must be an http(s) URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`${S3_ENDPOINT_ENV_VAR} must use http or https.`);
    }
    return parsed;
}

/** The S3 API URL for an object. This is not necessarily a public URL. */
export function s3ObjectUrl(settings: S3Settings, key: string): string {
    const endpoint = endpointURL(settings);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    const encodedKey = encodeS3Key(key);
    if (settings.addressingStyle === "virtual") {
        return `${endpoint.protocol}//${settings.bucket}.${endpoint.host}${basePath}/${encodedKey}`;
    }
    return `${endpoint.protocol}//${endpoint.host}${basePath}/${encodeS3Segment(settings.bucket)}/${encodedKey}`;
}

/**
 * The URL users can share when the provider exposes the bucket publicly
 * (an R2 public domain, a B2 download URL, or a custom CDN). Null when no
 * base URL is configured.
 */
export function publicS3ObjectUrl(
    settings: S3Settings,
    key: string,
    publicBaseURL: string | undefined,
): string | null {
    const base = publicBaseURL?.trim() ?? "";
    if (base.length === 0) {
        return null;
    }
    return `${base.replace(/\/+$/, "")}/${encodeS3Key(key)}`;
}

async function createS3Client(settings: S3Settings): Promise<S3Client> {
    const { S3Client } = await loadSdk();
    const config: S3ClientConfig = {
        region: settings.region,
        endpoint: settings.endpoint,
        forcePathStyle: settings.addressingStyle === "path",
        credentials: {
            accessKeyId: settings.accessKeyID,
            secretAccessKey: settings.secretAccessKey,
        },
        // B2/R2 do not need the optional flexible-checksum headers, and
        // leaving them out keeps the CORS preflight smaller.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        requestHandler: new FetchHttpHandler({ requestTimeout: S3_TIMEOUT_MS }),
    };
    return new S3Client(config);
}

function errorStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null) {
        return null;
    }
    const metadata = (error as { $metadata?: unknown }).$metadata;
    if (typeof metadata !== "object" || metadata === null) {
        return null;
    }
    const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
    return typeof status === "number" ? status : null;
}

function isNotFound(error: unknown): boolean {
    return errorStatus(error) === 404 || (error instanceof Error && error.name === "NotFound");
}

function s3Failure(error: unknown, action: string): Error {
    const status = errorStatus(error);
    if (status === 403) {
        return new Error(
            `S3 refused the ${action} (403). Check the access key, bucket permissions, and CORS. ` +
            `(${errorMessage(error)})`,
        );
    }
    if (status === 404) {
        return new Error(
            `S3 could not find the bucket or object (404). Check the endpoint and bucket. (${errorMessage(error)})`,
        );
    }
    if (status !== null) {
        return new Error(`S3 could not ${action} the config (${status}): ${errorMessage(error)}`);
    }
    return new Error(
        `${errorMessage(error)}. Check the endpoint and make sure the bucket allows CORS requests ` +
        `from this page (PUT, HEAD, authorization, x-amz-*, content-type and if-* headers).`,
    );
}

async function withTimeout<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);
    try {
        return await action(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Timed out after ${S3_TIMEOUT_MS / 1000}s talking to the S3 endpoint.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/** Read the current object's ETag, or nothing when it does not exist yet. */
export async function headS3Object(settings: S3Settings, key: string): Promise<S3ObjectInfo> {
    const { HeadObjectCommand } = await loadSdk();
    const client = await createS3Client(settings);
    try {
        const response = await withTimeout((signal) => client.send(
            new HeadObjectCommand({ Bucket: settings.bucket, Key: key }),
            { abortSignal: signal },
        ));
        return { exists: true, etag: response.ETag ?? null };
    } catch (error) {
        if (isNotFound(error)) {
            return { exists: false, etag: null };
        }
        throw s3Failure(error, "read");
    } finally {
        client.destroy();
    }
}

/**
 * Write one config file. Returns the object's new ETag when exposed.
 *
 * No conditional `If-Match` / `If-None-Match` header is sent: those preconditions
 * are optional in S3, and some providers (Backblaze B2 among them) reject them
 * with `501 NotImplemented`. Callers enforce concurrency with a `HEAD` check
 * before calling this function.
 */
export async function putS3Object(
    settings: S3Settings,
    key: string,
    text: string,
): Promise<{ etag: string | null }> {
    const { PutObjectCommand } = await loadSdk();
    const client = await createS3Client(settings);
    try {
        const response = await withTimeout((signal) => client.send(
            new PutObjectCommand({
                Bucket: settings.bucket,
                Key: key,
                Body: text,
                ContentType: "application/toml; charset=utf-8",
            }),
            { abortSignal: signal },
        ));
        return { etag: response.ETag ?? null };
    } catch (error) {
        throw s3Failure(error, "save");
    } finally {
        client.destroy();
    }
}
