/**
 * Result file sources for the file browser.
 *
 * Three sources cover every way outputs reach the dashboard:
 *   - `httpApi`  — a live `even-pf` process in WebUI mode (`#api=…`)
 *   - `hash`     — a single file embedded in the URL hash (`#name=…&comp=gzip&data=…`)
 *   - `vfs`      — the browser workspace produced by EPF in the browser (ZenFS)
 */

export type ResultFileEntry = {
	name: string;
	type: "markdown" | "text";
	modification_time: string;
};

export type ResultFileContent = {
	name: string;
	type: "markdown" | "text";
	content: string;
};

export type ResultFileSource = {
	/** Shown in the page header. */
	label: string;
	/** Polling interval in ms, or null when the source is static. */
	refreshIntervalMs: number | null;
	list(): Promise<ResultFileEntry[]>;
	read(name: string): Promise<ResultFileContent>;
};

export function fileTypeFor(name: string): "markdown" | "text" {
	return name.endsWith(".md") ? "markdown" : "text";
}

// --- HTTP API source (the CLI's WebUI mode) ---

export function createHttpApiFileSource(apiBaseUrl: string): ResultFileSource {
	const base = apiBaseUrl.replace(/\/+$/, "");
	return {
		label: `live API ${base}`,
		refreshIntervalMs: 3000,
		async list(): Promise<ResultFileEntry[]> {
			const res = await fetch(`${base}/`);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = await res.json();
			const rawFiles: Array<{ name: string; type?: "markdown" | "text"; modification_time?: unknown }> =
				data.files ?? data;
			return rawFiles.map((file) => ({
				name: file.name,
				type: file.type ?? fileTypeFor(file.name),
				modification_time: new Date((file.modification_time as string | number | Date) ?? Date.now()).toISOString(),
			}));
		},
		async read(name: string): Promise<ResultFileContent> {
			const res = await fetch(`${base}/${encodeURIComponent(name)}`);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = await res.json();
			return {
				name,
				type: data.type ?? fileTypeFor(name),
				content: data.content ?? "",
			};
		},
	};
}

// --- Hash source (single file embedded in the URL) ---

export const SUPPORTED_COMPRESSIONS = new Set(["", "none", "plain", "gzip"]);

export type HashFileParams = {
	name: string;
	comp: string;
	data: string;
};

/** Extract the embedded-file parameters from a location hash, or null. */
export function parseHashFileParams(hash: string): HashFileParams | null {
	const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
	const params = new URLSearchParams(rawHash);
	const data = params.get("data")?.trim() ?? "";
	if (data.length === 0) {
		return null;
	}
	return {
		name: params.get("name")?.trim() || "document.md",
		comp: params.get("comp")?.trim().toLowerCase() ?? "",
		data,
	};
}

function normalizeBase64(input: string): string {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padding = normalized.length % 4;
	return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
}

function base64ToBytes(input: string): Uint8Array {
	const binary = atob(normalizeBase64(input));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function decompressIfNeeded(bytes: Uint8Array, compValue: string): Promise<string> {
	if (!compValue || compValue === "none" || compValue === "plain") {
		return new TextDecoder().decode(bytes);
	}
	if (compValue !== "gzip") {
		throw new Error(`Unsupported compression: ${compValue}`);
	}
	if (typeof DecompressionStream === "undefined") {
		throw new Error("This browser does not support gzip decompression.");
	}
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(stream).text();
}

/** Build a single-file source from the hash payload (throws for bad input). */
export async function createHashFileSource(params: HashFileParams): Promise<ResultFileSource> {
	if (!SUPPORTED_COMPRESSIONS.has(params.comp)) {
		throw new Error(`Unsupported compression: ${params.comp || "(empty)"}`);
	}
	const content = await decompressIfNeeded(base64ToBytes(params.data), params.comp);
	const type = fileTypeFor(params.name);
	return {
		label: "file from URL hash",
		refreshIntervalMs: null,
		async list(): Promise<ResultFileEntry[]> {
			return [{ name: params.name, type, modification_time: new Date().toISOString() }];
		},
		async read(): Promise<ResultFileContent> {
			return { name: params.name, type, content };
		},
	};
}

// --- VFS source (outputs of the in-browser EPF) ---

/**
 * Reads the browser workspace. The EPF session owns the workspace lookup and
 * caches file contents, so listing stays cheap and reading one file does not
 * read the rest.
 */
export type WorkspaceOutputReader = {
	/** Names plus modification times of the recorded output files. */
	listOutputs(): Promise<ResultFileEntry[]>;
	/** One output file, read fresh when its modification time changed. */
	readOutput(name: string): Promise<ResultFileContent>;
};

export function createVfsFileSource(outputs: WorkspaceOutputReader, label = "browser workspace"): ResultFileSource {
	return {
		label,
		refreshIntervalMs: 3000,
		list: () => outputs.listOutputs(),
		read: (name: string) => outputs.readOutput(name),
	};
}
