/**
 * Error-to-text conversion shared by every host.
 *
 * `catch` values are `unknown`, and the same two-line idiom was repeated
 * throughout the CLI, the browser host and the dashboard. Keeping it in one
 * place also makes the message format consistent in logs and UI feedback.
 */

/** Readable message for a thrown value: `Error.message`, or its string form. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
