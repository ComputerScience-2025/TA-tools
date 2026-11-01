<script lang="ts">
	import { onMount } from "svelte";
	import { toast } from "@zerodevx/svelte-toast";

	import "@xterm/xterm/css/xterm.css";

	import { errorMessage } from "$epf/util/errors.ts";

	import { epfSession } from "$lib/epf/session";
	import { darkMode } from "$lib/stores";

	const { configLoaded, logs, busy } = epfSession;

	let container: HTMLDivElement;
	let ready = $state(false);
	/** True while a command is executing (toolbar buttons are disabled). */
	let running = $state(false);

	const DARK_THEME = {
		background: "#1f1f1f",
		foreground: "#e8e8e8",
		cursor: "#e8e8e8",
		selectionBackground: "#485fc7"
	};
	const LIGHT_THEME = {
		background: "#fafafa",
		foreground: "#1f1f1f",
		cursor: "#1f1f1f",
		selectionBackground: "#c9d4ff"
	};

	type TerminalLike = {
		open(element: HTMLElement): void;
		dispose(): void;
		attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
		input(data: string, wasUserInput?: boolean): void;
		options: { theme?: Record<string, string> };
		focus(): void;
	};
	type ReadlineLike = {
		read(prompt: string): Promise<string>;
		println(text: string): void;
		print(text: string): void;
		writeReady(): boolean;
		getLine(): string;
		updateLine(text: string): void;
		dispose(): void;
	};

	let disposed = false;
	let term: TerminalLike | null = null;
	let readline: ReadlineLike | null = null;
	let resizeObserver: ResizeObserver | null = null;
	/**
	 * Output written while read() is pending would land on top of the prompt:
	 * xterm-readline has no print-above-prompt support. Queue it and flush once
	 * the line has been submitted.
	 */
	let reading = false;
	let pendingOutput: string[] = [];

	/** ANSI colours mirror the CLI's chalk usage (cyan slugs, red warnings). */
	const colour = (level: string, text: string): string => {
		switch (level) {
			case "warn":
				return `\x1b[33m${text}\x1b[0m`;
			case "error":
				return `\x1b[31m${text}\x1b[0m`;
			case "debug":
				return `\x1b[90m${text}\x1b[0m`;
			default:
				return text;
		}
	};

	const formatEntry = (entry: { level: string; slug?: string; message: string; detail?: string }): string => {
		const prefix = entry.slug ? `\x1b[36m[${entry.slug}]\x1b[0m ` : "";
		const detail = entry.detail ? `\x1b[90m${entry.detail}\x1b[0m` : "";
		return `${prefix}${colour(entry.level, entry.message)}${detail ? ` ${detail}` : ""}`;
	};

	const emit = (text: string): void => {
		if (readline === null) {
			return;
		}
		if (reading) {
			pendingOutput.push(text);
			return;
		}
		readline.println(text);
	};

	const flushPending = (): void => {
		if (readline === null || reading) {
			return;
		}
		const queued = pendingOutput;
		pendingOutput = [];
		for (const text of queued) {
			readline.println(text);
		}
	};

	const writeEntry = (entry: { level: string; slug?: string; message: string; detail?: string }): void => {
		emit(formatEntry(entry));
	};

	const copyLog = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText($logs.map((entry) => epfSession.formatLog(entry)).join("\n"));
			toast.push("Log copied.");
		} catch (err) {
			const message = errorMessage(err);
			toast.push(`Could not copy the log: ${message}`);
		}
	};

	onMount(() => {
		// xterm-readline's dispose() does not settle a pending read(), so race the
		// read against this promise to let the console loop exit on unmount.
		let resolveDisposed: (() => void) | null = null;
		const disposedPromise = new Promise<null>((resolve) => {
			resolveDisposed = () => resolve(null);
		});
		let releaseSubscriptions: (() => void) | null = null;

		void (async () => {
			const [{ Terminal }, { FitAddon }, { Readline }] = await Promise.all([
				import("@xterm/xterm"),
				import("@xterm/addon-fit"),
				import("xterm-readline")
			]);
			if (disposed) {
				return;
			}

			const terminal = new Terminal({
				convertEol: true,
				fontSize: 13,
				scrollback: 5000,
				cursorBlink: true,
				theme: $darkMode ? DARK_THEME : LIGHT_THEME
			});
			const fit = new FitAddon();
			const rl = new Readline();

			terminal.loadAddon(fit);
			terminal.loadAddon(rl);
			terminal.open(container);
			fit.fit();

			term = terminal as unknown as TerminalLike;
			readline = rl as unknown as ReadlineLike;
			ready = true;

			const unsubscribeTheme = darkMode.subscribe((dark) => {
				if (term !== null) {
					term.options = { theme: dark ? DARK_THEME : LIGHT_THEME };
				}
			});

			// The terminal's CSS size changes with the window; xterm itself does
			// not observe it, and a stale column count breaks wrapping and prompt
			// redraws.
			const observer = new ResizeObserver(() => {
				if (!disposed && term !== null) {
					try {
						fit.fit();
					} catch {
						// The terminal is being disposed.
					}
				}
			});
			resizeObserver = observer;
			observer.observe(container);

			// Tab completion edits the line in place. Printing candidates while
			// read() is active would corrupt the prompt.
			terminal.attachCustomKeyEventHandler((event) => {
				if (event.type !== "keydown" || event.key !== "Tab") {
					return true;
				}
				const current = rl.getLine();
				const completion = epfSession.complete(current);
				if (completion.text !== current) {
					rl.updateLine(completion.text);
				}
				return false;
			});

			rl.println("\x1b[90mEPF browser session. Type 'help' for commands, 'exit' does nothing here.\x1b[0m");

			try {
				await epfSession.ensure();
			} catch (err) {
				rl.println(`\x1b[31mFailed to start the session: ${errorMessage(err)}\x1b[0m`);
				unsubscribeTheme();
				return;
			}

			for (const entry of epfSession.getLogSnapshot()) {
				writeEntry(entry);
			}
			const unsubscribeLogs = epfSession.subscribeLogs((entry) => {
				writeEntry(entry);
			});
			releaseSubscriptions = () => {
				unsubscribeLogs();
				unsubscribeTheme();
			};
			if (disposed) {
				releaseSubscriptions();
				releaseSubscriptions = null;
				return;
			}

			while (!disposed) {
				reading = true;
				let line: string | null;
				try {
					line = await Promise.race([rl.read("epf> "), disposedPromise]);
				} catch {
					reading = false;
					break;
				}
				reading = false;
				if (disposed || line === null) {
					break;
				}
				flushPending();
				running = true;
				try {
					const result = await epfSession.execute(line);
					if (!disposed && result.message.length > 0) {
						emit(colour(result.kind === "error" ? "error" : "info", result.message));
					}
				} catch (err) {
					if (!disposed) {
						emit(colour("error", errorMessage(err)));
					}
				} finally {
					running = false;
				}
			}
		})();

		return () => {
			disposed = true;
			reading = false;
			pendingOutput = [];
			resolveDisposed?.();
			resolveDisposed = null;
			releaseSubscriptions?.();
			releaseSubscriptions = null;
			resizeObserver?.disconnect();
			resizeObserver = null;
			try {
				readline?.dispose();
			} catch {
				// Already disposed with the terminal.
			}
			readline = null;
			term?.dispose();
			term = null;
		};
	});

	const runCommand = (line: string): void => {
		if (running || readline === null || term === null) {
			return;
		}
		if (reading) {
			// Submit the command through the normal REPL loop. Its output is then
			// printed while no prompt is active, and the loop restores the prompt.
			readline.updateLine(line);
			term.input("\r");
			term.focus();
			return;
		}
		void (async () => {
			running = true;
			try {
				const result = await epfSession.execute(line);
				writeEntry({ level: result.kind === "error" ? "error" : "info", message: result.message });
			} catch (err) {
				writeEntry({ level: "error", message: errorMessage(err) });
			} finally {
				running = false;
			}
		})();
	};
</script>

<div class="is-flex is-justify-content-space-between is-align-items-center mb-3">
	<div class="buttons has-addons mb-0">
		<button class="button is-small" onclick={() => runCommand("run")} disabled={!$configLoaded || !ready || running || $busy}>Run all</button>
		<button class="button is-small" onclick={() => runCommand("rerun")} disabled={!$configLoaded || !ready || running || $busy}>Rerun</button>
		<button class="button is-small" onclick={() => runCommand("status")} disabled={!$configLoaded || !ready || running || $busy}>Status</button>
		<button class="button is-small" onclick={() => runCommand("list")} disabled={!$configLoaded || !ready || running || $busy}>List</button>
		<button class="button is-small" onclick={() => runCommand("clear")} disabled={!$configLoaded || !ready || running || $busy}>Clear outputs</button>
		<button class="button is-small" onclick={() => runCommand("reload")} disabled={!$configLoaded || !ready || running || $busy}>Reload config</button>
	</div>
	<div class="buttons mb-0">
		<button class="button is-small is-light" onclick={() => epfSession.clearLog()} disabled={running || $busy}>Clear log</button>
		<button class="button is-small is-light" onclick={() => void copyLog()}>Copy log</button>
	</div>
</div>

<div class="console" bind:this={container}></div>

{#if !ready}
	<p class="is-size-7 has-text-grey mt-2">Starting the console…</p>
{/if}

<style>
	.console {
		height: 26rem;
		padding: 0.5rem;
		border-radius: 6px;
		overflow: hidden;
		background: var(--console-background, #fafafa);
	}

	:global(html[data-theme="dark"]) .console {
		--console-background: #1f1f1f;
	}
</style>
