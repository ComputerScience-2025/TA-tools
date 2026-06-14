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
 * The HTTP serving layer lives in ApiServer (src/api-server.ts).
 */
export class OutputViewer {
    fileRecords: Record<string, FileRecord> = {};

    async addFile(filename: string, fileRecord: Omit<FileRecord, "modification_time">): Promise<void> {
        await Bun.write(filename, fileRecord.content);
        this.fileRecords[filename] = {
            ...fileRecord,
            modification_time: new Date(),
        };
    }

    /**
     * Remove files matching the given slug substrings.
     * If no filter is provided (or empty array), clear everything.
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
