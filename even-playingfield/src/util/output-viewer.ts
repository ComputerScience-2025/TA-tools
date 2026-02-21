import chalk from "chalk";

type FileRecord = {
    type: "markdown" | "text";
    content: string;
}

export class OutputViewer {
    filesRecords: Record<string, FileRecord> = {};
    
    
    addFile(filename: string, _: FileRecord): void {
        this.filesRecords[filename] = _;
    }
    
    private serve(): void {
        let files = Object.entries(this.filesRecords).sort((a, b) => a[0].localeCompare(b[0]));
        
        let server = Bun.serve({
            port: 0,
            routes: {
                "/:slug": (req) => {
                    let slug = req.params.slug;
                    console.log(`Request for slug: "${slug}"`);
                    return new Response(this.filesRecords[slug]?.content ?? "Not Found");
                }
            },
            fetch(req) {
                return new Response("Not Found (fallback)", { status: 404 });
            },
        });
        console.log(server.url);
    }
    
    display() {
        if (Object.keys(this.filesRecords).length === 0) {
            console.warn("No files to display");
            return;
        }
        
        console.log("Click the following links to view the outputs in your browser:");
        
        const FRONTEND_URL = "https://ta-tools-dashboard.vercel.app/tools/md-viewer"; //TODO: not hardcode this
        let files = Object.entries(this.filesRecords).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [filename, fileRecord] of files) {
            let params = new URLSearchParams();
            params.set("name", filename);
            params.set("comp", "gzip");
            params.set("data", Bun.gzipSync(fileRecord.content).toBase64());
            let url = `${FRONTEND_URL}#${params.toString()}`;
            console.log(`${chalk.cyan(filename)}: ${url}`);
        }
    }
}
