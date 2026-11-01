/**
 * Display formatting helpers shared by the CLI, the browser host and the
 * dashboard. Nothing here touches a platform API.
 */

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Human-readable byte count, e.g. `1.5 MB`. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unitIndex]}`;
}
