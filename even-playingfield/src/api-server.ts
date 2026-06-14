import type { Engine } from "./engine/index.ts";
import { parseAndExecute } from "./command-handler.ts";

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
        },
    });
}

function corsPreflightResponse(): Response {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

type ApiServerHandle = {
    url: string;
    stop: () => void;
};

/**
 * HTTP server that serves both file-data routes (migrated from OutputViewer)
 * and command routes (POST /api/commands).  Both use the same Engine instance
 * that the CLI REPL also talks to.
 */
export function startApiServer(engine: Engine, port: number): ApiServerHandle {
    const server = Bun.serve({
        port,
        routes: {
            // --- File data routes (migrated from OutputViewer.serve) ---
            "/": (req) => {
                if (req.method === "OPTIONS") {
                    return corsPreflightResponse();
                }
                const files = engine.outputViewer.getFileList().map((f) => ({
                    name: f.name,
                    type: f.type,
                    modification_time: f.modification_time,
                }));
                return jsonResponse({ files });
            },

            // --- Command route ---
            "/api/commands": async (req) => {
                if (req.method === "OPTIONS") {
                    return corsPreflightResponse();
                }
                if (req.method !== "POST") {
                    return jsonResponse({ error: "Method Not Allowed. Use POST." }, 405);
                }
                try {
                    const body = await req.json() as { command?: string };
                    const command = body?.command?.trim() ?? "";
                    if (command.length === 0) {
                        return jsonResponse({ error: "Missing 'command' field in request body." }, 400);
                    }
                    const result = await parseAndExecute(engine, command);
                    return jsonResponse(result);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return jsonResponse({ kind: "error", message: `Server error: ${message}` }, 500);
                }
            },

            // --- Single file data route ---
            "/:slug": (req) => {
                if (req.method === "OPTIONS") {
                    return corsPreflightResponse();
                }
                const slug = req.params.slug;
                const record = engine.outputViewer.getFile(slug);
                if (!record) {
                    return jsonResponse({ error: "Not Found" }, 404);
                }
                return jsonResponse({
                    name: slug,
                    type: record.type,
                    content: record.content,
                });
            },
        },
        fetch(req) {
            if (req.method === "OPTIONS") {
                return corsPreflightResponse();
            }
            return jsonResponse({ error: "Not Found" }, 404);
        },
    });

    const url = server.url.toString();
    console.log(`API server listening at ${url}`);

    return {
        url,
        stop: () => server.stop(),
    };
}
