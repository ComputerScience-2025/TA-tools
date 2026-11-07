<script lang="ts">
	import { flushSync, tick } from "svelte";

	import { highlightMarkdownSource } from "$lib/markdown-highlight.ts";

	/**
	 * A Markdown-aware replacement for a plain <textarea>.
	 *
	 * The textarea keeps every native editing behaviour (caret, selection, IME,
	 * undo, spellcheck off) but paints transparent text on top of a highlighted
	 * mirror. highlight.js escapes its input, so the generated markup is safe to
	 * inject; the token colours come from the GitHub theme styles that
	 * +layout.svelte injects for the current light/dark mode.
	 *
	 * Tab indents instead of moving focus (Esc makes the next Tab move focus).
	 */

	const INDENT = "\t";
	const DEDENT_RE = /^(\t| {1,4})/;

	let {
		id,
		value,
		rows = 5,
		disabled = false,
		onInput
	}: {
		id?: string;
		value: string;
		rows?: number;
		disabled?: boolean;
		onInput: (next: string) => void;
	} = $props();

	let field = $state<HTMLDivElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let mirror = $state<HTMLPreElement | null>(null);
	/** Width of the textarea's scrollbar, mirrored as padding in the overlay. */
	let gutter = $state(0);
	/** Escape arms one pass-through so Tab can still move focus out of the field. */
	let tabExits = false;
	/**
	 * Whether the textarea owns the caret. The idle textarea is hidden from the
	 * page so the highlighted mirror is the only copy of the text that
	 * find-in-page can see; while editing, both layers stay visible (the
	 * textarea's own text is transparent) so the token colours are kept.
	 */
	let focused = $state(false);
	/** Caret offset captured by a click on the idle field, applied on focus. */
	let pendingCaret: number | null = null;
	/** Idle, the wrapper is the field's tab stop; while editing, the textarea is. */
	let fieldTabIndex = $derived(disabled ? undefined : focused ? -1 : 0);

	const highlighted = $derived(highlightMarkdown(value));

	function highlightMarkdown(text: string): string {
		if (text.length === 0) {
			return "";
		}
		const html = highlightMarkdownSource(text);
		// A trailing newline ends the last line without adding a line box, but
		// the textarea does show the empty final line. Add one to match.
		return text.endsWith("\n") ? `${html}\n` : html;
	}

	function syncScroll(): void {
		if (textarea === null || mirror === null) {
			return;
		}
		mirror.scrollTop = textarea.scrollTop;
		mirror.scrollLeft = textarea.scrollLeft;
	}

	/** Locate the caret under a viewport point, using either browser API. */
	function caretRangeAt(clientX: number, clientY: number): Range | null {
		if (typeof document.caretRangeFromPoint === "function") {
			const range = document.caretRangeFromPoint(clientX, clientY);
			if (range !== null) {
				return range;
			}
		}
		if (typeof document.caretPositionFromPoint !== "function") {
			return null;
		}
		const position = document.caretPositionFromPoint(clientX, clientY);
		if (position === null) {
			return null;
		}
		const fallback = document.createRange();
		fallback.setStart(position.offsetNode, position.offset);
		fallback.collapse(true);
		return fallback;
	}

	/**
	 * Map a viewport point to an offset in the source text. The mirror lays the
	 * text out exactly like the textarea, so summing its text nodes gives the
	 * textarea's offsets; the mirror may carry one extra trailing newline, hence
	 * the clamp.
	 */
	function offsetAtPoint(clientX: number, clientY: number): number | null {
		const pre = mirror;
		if (pre === null) {
			return null;
		}
		const range = caretRangeAt(clientX, clientY);
		if (range === null || !pre.contains(range.startContainer)) {
			return null;
		}
		let offset = 0;
		const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node !== null && node !== range.startContainer) {
			offset += (node as Text).data.length;
			node = walker.nextNode();
		}
		if (node === null) {
			return null;
		}
		return Math.min(offset + range.startOffset, value.length);
	}

	/** Reveal the textarea (and its caret) and place the caret at `offset`. */
	function enterField(offset: number | null): void {
		const el = textarea;
		pendingCaret = null;
		if (el === null || disabled) {
			return;
		}
		// The wrapper forwards focus, so the textarea has to become visible in
		// this same event turn for the caret and any following drag to land.
		flushSync(() => {
			focused = true;
		});
		el.focus();
		const caret = Math.min(offset ?? el.value.length, el.value.length);
		el.setSelectionRange(caret, caret);
	}

	function handleFocus(): void {
		focused = true;
	}

	function handleBlur(): void {
		tabExits = false;
		// Keep the idle mirror showing the same part of the text.
		syncScroll();
		focused = false;
	}

	/** Keyboard focus lands on the wrapper: the idle textarea is not tabbable. */
	function handleFieldFocus(): void {
		enterField(pendingCaret);
	}

	function handleFieldPointerDown(event: MouseEvent): void {
		if (disabled || focused || event.button !== 0) {
			return;
		}
		pendingCaret = offsetAtPoint(event.clientX, event.clientY);
	}

	/** Fallback for platforms that focus the wrapper without a mousedown focus. */
	function handleFieldMouseUp(): void {
		if (!focused) {
			enterField(pendingCaret);
		}
	}

	/**
	 * The field's <label> activates the control, but the idle textarea is not
	 * focusable; a synthetic click still arrives, so use it to reveal the editor.
	 */
	function handleControlClick(): void {
		if (!focused) {
			enterField(pendingCaret);
		}
	}

	/** Grow to fit the content; the CSS min/max heights clamp the result. */
	function fitHeight(): void {
		const el = textarea;
		if (el === null) {
			return;
		}
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
		const next = el.offsetWidth - el.clientWidth;
		if (next !== gutter) {
			gutter = next;
		}
		syncScroll();
	}

	// Re-run whenever the text (or the row count) changes. `$effect` runs after
	// the DOM value has been updated, so scrollHeight is current.
	$effect(() => {
		void value;
		void rows;
		fitHeight();
	});

	// Wrapping depends on the width; refit when the layout width changes.
	$effect(() => {
		const el = field;
		if (el === null) {
			return;
		}
		let lastWidth = el.clientWidth;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth !== lastWidth) {
				lastWidth = el.clientWidth;
				fitHeight();
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	});

	type Edit = { text: string; start: number; end: number };

	function lineStartOf(text: string, position: number): number {
		return text.lastIndexOf("\n", position - 1) + 1;
	}

	function lineEndOf(text: string, position: number): number {
		const index = text.indexOf("\n", position);
		return index === -1 ? text.length : index;
	}

	function indentLines(text: string, start: number, end: number): Edit {
		const lineStart = lineStartOf(text, start);
		const blockEnd = lineEndOf(text, end);
		const lines = text.slice(lineStart, blockEnd).split("\n");
		return {
			text: text.slice(0, lineStart) +
				lines.map((line) => INDENT + line).join("\n") +
				text.slice(blockEnd),
			start: start + INDENT.length,
			end: end + lines.length * INDENT.length
		};
	}

	function dedentLines(text: string, start: number, end: number): Edit {
		const lineStart = lineStartOf(text, start);
		const blockEnd = lineEndOf(text, end);
		let removedFirst = 0;
		let removed = 0;
		const lines = text.slice(lineStart, blockEnd).split("\n").map((line, index) => {
			const match = DEDENT_RE.exec(line);
			if (match === null) {
				return line;
			}
			if (index === 0) {
				removedFirst = match[0].length;
			}
			removed += match[0].length;
			return line.slice(match[0].length);
		});
		if (removed === 0) {
			return { text, start, end };
		}
		return {
			text: text.slice(0, lineStart) + lines.join("\n") + text.slice(blockEnd),
			start: Math.max(lineStart, start - removedFirst),
			end: Math.max(lineStart, end - removed)
		};
	}

	function applyEdit(edit: Edit): void {
		const el = textarea;
		if (el === null) {
			return;
		}
		if (edit.text === el.value) {
			el.setSelectionRange(edit.start, edit.end);
			return;
		}
		el.value = edit.text;
		el.setSelectionRange(edit.start, edit.end);
		onInput(edit.text);
		// The parent writes the value back, which resets the caret; restore it
		// once that update has been applied.
		void tick().then(() => {
			if (textarea === el) {
				el.setSelectionRange(edit.start, edit.end);
			}
		});
	}

	function handleKeydown(event: KeyboardEvent): void {
		const el = event.currentTarget as HTMLTextAreaElement;
		if (event.key === "Escape") {
			tabExits = true;
			return;
		}
		if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) {
			tabExits = false;
			return;
		}
		if (tabExits) {
			tabExits = false;
			return;
		}
		event.preventDefault();
		const start = el.selectionStart;
		const end = el.selectionEnd;
		if (event.shiftKey) {
			applyEdit(dedentLines(el.value, start, end));
			return;
		}
		if (start !== end && el.value.slice(start, end).includes("\n")) {
			applyEdit(indentLines(el.value, start, end));
			return;
		}
		applyEdit({
			text: el.value.slice(0, start) + INDENT + el.value.slice(end),
			start: start + INDENT.length,
			end: start + INDENT.length
		});
	}
</script>

<div
	class="md-field"
	bind:this={field}
	style="--md-min-rows: {rows}; --md-gutter: {gutter}px"
	role="textbox"
	aria-multiline="true"
	aria-readonly={focused ? undefined : true}
	tabindex={fieldTabIndex}
	onfocus={handleFieldFocus}
	onmousedown={handleFieldPointerDown}
	onmouseup={handleFieldMouseUp}
>
	<pre class="md-mirror" bind:this={mirror} aria-hidden={focused}><code>{@html highlighted}</code></pre>
	<textarea
		bind:this={textarea}
		{id}
		{rows}
		class="md-input"
		class:md-input-idle={!focused}
		{disabled}
		spellcheck="false"
		autocapitalize="off"
		autocomplete="off"
		value={value}
		oninput={(event) => onInput(event.currentTarget.value)}
		onkeydown={handleKeydown}
		onfocus={handleFocus}
		onblur={handleBlur}
		onclick={handleControlClick}
		onscroll={syncScroll}
	></textarea>
</div>
<p class="help">Tab indents, Shift+Tab outdents. Press Esc, then Tab, to move to the next field.</p>

<style>
	.md-field {
		position: relative;
		min-height: calc(var(--md-min-rows) * 1.5em + 1em);
		background-color: var(--bulma-scheme-main-bis);
		border: 1px solid var(--bulma-border-weak);
		border-radius: var(--bulma-radius);
		box-sizing: border-box;
		font-family: var(--bulma-family-code);
		font-size: 0.75rem;
		line-height: 1.5;
		tab-size: 4;
		cursor: text;
		/* The wrapper is focusable only to forward Tab into the textarea; the
		   :focus-within border below is the visible focus indicator. */
		outline: none;
	}

	.md-field:focus-within {
		border-color: var(--bulma-link);
		box-shadow: 0 0 0 0.125em
			hsla(var(--bulma-focus-h), var(--bulma-focus-s), var(--bulma-focus-l), var(--bulma-focus-shadow-alpha));
	}

	.md-mirror,
	.md-input {
		box-sizing: border-box;
		margin: 0;
		border: 0;
		padding: 0.5em 0.75em;
		font: inherit;
		line-height: inherit;
		letter-spacing: inherit;
		tab-size: inherit;
		white-space: pre-wrap;
		overflow-wrap: break-word;
		word-break: normal;
		/* The overlay and the textarea must advance every glyph identically, or
		   the caret drifts away from the highlighted text. Chrome gives the
		   textarea `auto` while the mirror would inherit Bulma's
		   optimizeLegibility (kerning + ligatures), so pin both. */
		text-rendering: auto;
		font-kerning: none;
		font-variant-ligatures: none;
	}

	.md-mirror {
		position: absolute;
		inset: 0;
		overflow: hidden;
		background: transparent;
		color: var(--bulma-text);
		padding-right: calc(0.75em + var(--md-gutter));
		pointer-events: none;
	}

	.md-mirror code {
		background: none;
		color: inherit;
		font: inherit;
		padding: 0;
	}

	.md-input {
		position: relative;
		display: block;
		width: 100%;
		min-height: calc(var(--md-min-rows) * 1.5em + 1em);
		max-height: 36rem;
		resize: none;
		overflow-y: auto;
		background-color: transparent;
		color: transparent;
		caret-color: var(--bulma-text-strong);
		outline: none;
	}

	/* An idle field hides the textarea so the highlighted mirror is the only
	   copy of the text that find-in-page can see. Visibility keeps the layout,
	   so the field's height and the scroll offset survive the switch. */
	.md-input-idle {
		visibility: hidden;
	}

	.md-input::selection {
		/* Transparent text plus a transparent background leaves the browser
		   nothing to paint the default highlight from, so supply one. The text
		   stays transparent to avoid ghosting over the mirror. */
		color: transparent;
		background-color: color-mix(in srgb, var(--bulma-link) 30%, transparent);
	}
</style>
