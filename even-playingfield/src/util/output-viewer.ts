import type { VirtualFileSystem } from "../platform/types.ts";

type FileRecord = {
    type: "markdown" | "text";
    content: string;
    modification_time: Date;
};

/**
 * Pure data store for workflow output files.
 * Persists across multiple workflow runs so that re-runs append/overwrite
 * rather than starting from scratch.
 *
 * Writes go through the platform filesystem, so outputs land in the current
 * Bash-style working directory on the CLI and in the browser workspace on the
 * web. The HTTP serving layer lives in ApiServer (src/api-server.ts).
 */
export class OutputViewer {
    fileRecords: Record<string, FileRecord> = {};
    private readonly fs: VirtualFileSystem;

    constructor(fs: VirtualFileSystem) {
        this.fs = fs;
    }

    async addFile(filename: string, fileRecord: Omit<FileRecord, "modification_time">): Promise<void> {
        await this.fs.writeText(filename, fileRecord.content);
        this.fileRecords[filename] = {
            ...fileRecord,
            modification_time: new Date(),
        };
    }

    /**
     * Remove files matching the given slug substrings.
     * If no filter is provided (or empty array), clear everything.
     * Only the in-memory record list is cleared; files on disk/browser storage
     * are left alone (the web host removes them via the filesystem directly).
     */
    clearFiles(slugFilter?: string[]): void {
        if (!slugFilter || slugFilter.length === 0) {
            this.fileRecords = {};
            return;
        }
        for (const key of Object.keys(this.fileRecords)) {
            if (slugFilter.some((s) => key.includes(s))) {
                delete this.fileRecords[key];
            }
        }
    }

    /** Delete exactly these filenames from the in-memory record list. */
    clearFileNames(names: readonly string[]): void {
        for (const name of names) {
            delete this.fileRecords[name];
        }
    }

    /** Return the sorted list of files (metadata only, no content). */
    getFileList(): { name: string; type: string; modification_time: Date }[] {
        return Object.entries(this.fileRecords)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([filename, record]) => ({
                name: filename,
                type: record.type,
                modification_time: record.modification_time,
            }));
    }

    /** Return a single file's record, or null if not found. */
    getFile(slug: string): FileRecord | null {
        return this.fileRecords[slug] ?? null;
    }
}
