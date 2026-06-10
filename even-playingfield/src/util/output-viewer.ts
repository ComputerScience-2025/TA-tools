import chalk from "chalk";

import {CONFIG} from "./config.ts";
import {OutputViewingModeEnum} from "./config-schema.ts";

type FileRecord = {
    type: "markdown" | "text";
    content: string;
}

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

export class OutputViewer {
    filesRecords: Record<string, FileRecord> = {};
    displayed: boolean = false;
    
    addFile(filename: string, _: FileRecord): void {
        this.filesRecords[filename] = _;
    }
    
    serve(): string {
        let files = Object.entries(this.filesRecords).sort((a, b) => a[0].localeCompare(b[0]));
        
        let server = Bun.serve({
            port: CONFIG.output_viewing.api_port,
            routes: {
                "/": (req) => {
                    if (req.method === "OPTIONS") {
                        return new Response(null, { status: 204, headers: CORS_HEADERS });
                    }
                    return jsonResponse({
                        files: files.map(([filename, fileRecord]) => ({
                            name: filename,
                            type: fileRecord.type,
                        })),
                    });
                },
                "/:slug": (req) => {
                    if (req.method === "OPTIONS") {
                        return new Response(null, { status: 204, headers: CORS_HEADERS });
                    }
                    let slug = req.params.slug;
                    let record = this.filesRecords[slug];
                    if (!record) {
                        return jsonResponse({ error: "Not Found" }, 404);
                    }
                    return jsonResponse({
                        name: slug,
                        type: record.type,
                        content: record.content,
                    });
                }
            },
            fetch(req) {
                if (req.method === "OPTIONS") {
                    return new Response(null, { status: 204, headers: CORS_HEADERS });
                }
                return jsonResponse({ error: "Not Found" }, 404);
            },
        });
        console.log(server.url);
        return server.url.toString();
    }
    
    display() {
        let frontendURL = "";
        switch (CONFIG.output_viewing.mode) {
            case OutputViewingModeEnum.Local:
                if (Object.keys(this.filesRecords).length === 0) {
                    console.warn("No files to display (you can probably ignore this warning if your workflows haven't completed yet)");
                    return;
                }
                
                console.log("Click the following links to view the outputs in your browser:");
                
                let files = Object.entries(this.filesRecords).sort((a, b) => a[0].localeCompare(b[0]));
                for (const [filename, fileRecord] of files) {
                    let params = new URLSearchParams();
                    params.set("name", filename);
                    params.set("comp", "gzip");
                    params.set("data", Bun.gzipSync(fileRecord.content).toBase64());
                    frontendURL = `${CONFIG.output_viewing.webui_base_url}/tools/results-viewer#${params.toString()}`;
                    console.log(`${chalk.cyan(filename)}: ${frontendURL}` + "\n");
                }
                break
            case OutputViewingModeEnum.WebUI:
                if (this.displayed){
                    console.log("Output viewer API is already running");
                    console.log(frontendURL + "\n");
                    console.log("Press Ctrl+C to stop")
                    return;
                }
                this.displayed = true;
                let apiURL = this.serve();
                let params = new URLSearchParams();
                params.set("api", apiURL);
                frontendURL = `${CONFIG.output_viewing.webui_base_url}/tools/results-viewer#${params.toString()}`;
                
                console.log(chalk.cyan("Open the following URL to view all outputs:"));
                console.log(frontendURL);
                console.log("Press Ctrl+C to stop the server")
        }
        
    }
}
