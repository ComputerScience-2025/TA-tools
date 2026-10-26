/**
 * `Logger` for the terminal.
 *
 * All chalk usage lives here (and in the hosts); the core only emits levels,
 * messages and context, so the same workflow code renders as ANSI text in a
 * terminal and as plain lines in the browser console pane.
 */

import chalk from "chalk";

import type { LogLevel, LogMeta, Logger } from "../types.ts";

export class BunLogger implements Logger {
    log(level: LogLevel, message: string, meta?: LogMeta): void {
        const slug = meta?.slug;
        const data = meta?.data ?? [];
        switch (level) {
            case "debug": {
                const prefix = slug ? chalk.gray(`[${slug}]`) : undefined;
                const args = data.map((value) => (typeof value === "string" ? chalk.gray(value) : value));
                console.debug(...(prefix ? [prefix, chalk.gray(message), ...args] : [chalk.gray(message), ...args]));
                return;
            }
            case "warn": {
                const prefix = slug ? chalk.red(`[${slug}]`) : undefined;
                console.warn(...(prefix ? [prefix, message, ...data] : [message, ...data]));
                return;
            }
            case "error": {
                const prefix = slug ? chalk.red(`[${slug}]`) : undefined;
                console.error(...(prefix ? [prefix, message, ...data] : [message, ...data]));
                return;
            }
            case "info":
            default: {
                const prefix = slug ? chalk.cyan(`[${slug}]`) : undefined;
                console.log(...(prefix ? [prefix, message, ...data] : [message, ...data]));
                return;
            }
        }
    }
}
