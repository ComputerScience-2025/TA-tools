<script lang="ts">
	import DOMPurify from "dompurify";

	import { marked, preprocessMarkdown } from "$lib/marked-config";
	import { epfSession } from "$lib/epf/session";

	import { buildTranscript } from "$epf/util/chat-session.ts";
	import type { TranscriptEntry } from "$epf/util/chat-session.ts";

	const { chatSessions, activeChatSession, chatStreaming, chatBusy, chatError, lastResults } = epfSession;

	let draft = $state("");
	let editingIndex = $state<number | null>(null);
	let editingText = $state("");
	let rendered = $state<Record<number, string>>({});
	let autoOpened = $state<string | null>(null);

	const session = $derived($activeChatSession);
	const transcript = $derived(session === null ? [] : buildTranscript(session));

	// Re-render assistant markdown when the transcript changes. Streaming text is
	// shown as plain pre-wrapped text instead, so each token does not re-parse
	// the whole conversation.
	$effect(() => {
		const current = session;
		let active = true;
		void (async () => {
			if (current === null) {
				if (active) {
					rendered = {};
				}
				return;
			}
			// Clear the previous session's HTML so index-keyed content cannot
			// flash inside the newly opened one.
			if (active) {
				rendered = {};
			}
			const next: Record<number, string> = {};
			for (const entry of buildTranscript(current)) {
				if (entry.role !== "assistant" || entry.text.length === 0) {
					continue;
				}
				const html = await marked.parse(preprocessMarkdown(entry.text));
				next[entry.index] = DOMPurify.sanitize(html);
			}
			if (active) {
				rendered = next;
			}
		})();
		return () => {
			active = false;
		};
	});

	// A finished run writes a session; refresh the list so it appears.
	$effect(() => {
		void $lastResults;
		void epfSession.refreshChatSessions();
	});

	// Open the newest session when nothing is selected (first visit, after a run,
	// or after deleting the open session).
	$effect(() => {
		const sessions = $chatSessions;
		if ($activeChatSession !== null || sessions.length === 0) {
			return;
		}
		const newest = sessions[0]!;
		if (autoOpened === newest.id) {
			return;
		}
		autoOpened = newest.id;
		void epfSession.openChatSession(newest.id);
	});

	const formatTime = (iso: string): string => {
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
	};

	const open = async (id: string): Promise<void> => {
		editingIndex = null;
		await epfSession.openChatSession(id);
	};

	const send = async (): Promise<void> => {
		const text = draft.trim();
		if (text.length === 0 || $chatBusy) {
			return;
		}
		draft = "";
		await epfSession.sendChatMessage(text);
	};

	const regenerate = async (): Promise<void> => {
		if ($chatBusy) {
			return;
		}
		await epfSession.regenerateChat();
	};

	const startEdit = (entry: TranscriptEntry): void => {
		editingIndex = entry.index;
		editingText = entry.text;
	};

	const saveEdit = async (): Promise<void> => {
		if (editingIndex === null || editingText.trim().length === 0) {
			return;
		}
		if (!confirm("Editing this message deletes every reply after it and generates a new one. Continue?")) {
			return;
		}
		const index = editingIndex;
		editingIndex = null;
		await epfSession.editChatMessage(index, editingText);
	};

	const remove = async (id: string): Promise<void> => {
		if (!confirm("Delete this chat session? The recorded transcript is removed.")) {
			return;
		}
		await epfSession.deleteChatSession(id);
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void send();
		}
	};
</script>

<div class="columns">
	<div class="column is-one-quarter">
		<p class="is-size-7 has-text-grey mb-2">
			Chat sessions for this workspace. Each analysis run starts one.
		</p>
		{#if $chatSessions.length === 0}
			<p class="is-size-7 has-text-grey">
				No sessions yet. Run a workflow from the Console tab.
			</p>
		{:else}
			<div class="session-list">
				{#each $chatSessions as summary (summary.id)}
					{@const selected = session?.id === summary.id}
					<button
						type="button"
						class={"button is-fullwidth session-item" + (selected ? " is-info" : " is-light")}
						onclick={() => void open(summary.id)}
						disabled={$chatBusy}
					>
						<span class="session-item-body">
							<span class="has-text-weight-semibold is-size-7">
								{summary.workflow_slug} · run {summary.run}
							</span>
							<span class={"is-size-7" + (selected ? "" : " has-text-grey")}>
								{formatTime(summary.updated_at)} · {summary.turns} turn(s)
							</span>
							<span class={"is-size-7" + (selected ? "" : " has-text-grey")}>{summary.id}</span>
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="column">
		{#if session === null}
			<article class="message is-info">
				<div class="message-body">
					Select a session to continue the conversation. The model is locked to the one the
					workflow used.
				</div>
			</article>
		{:else}
			<div class="is-flex is-justify-content-space-between is-align-items-start mb-3">
				<div>
					<p class="has-text-weight-semibold">{session.workflow.slug} · run {session.workflow.run}</p>
					<p class="is-size-7 has-text-grey">
						<code>{session.id}</code> · model <code>{session.workflow.model}</code>
						{#if session.workflow.provider_model !== undefined}
							({session.workflow.provider_model})
						{/if}
						· {session.origin}
					</p>
				</div>
				<button
					class="button is-small is-danger is-outlined"
					onclick={() => void remove(session.id)}
					disabled={$chatBusy}
				>
					Delete session
				</button>
			</div>

			<div class="chat-transcript">
				{#each transcript as entry (entry.index)}
					<article class={"box mb-3 " + (entry.role === "assistant" ? "chat-reply" : "chat-prompt")}>
						<div class="is-flex is-justify-content-space-between mb-2">
							<p class="is-size-7 has-text-weight-semibold is-capitalized">{entry.role}</p>
							{#if entry.meta !== undefined}
								<p class="is-size-7 has-text-grey">{formatTime(entry.meta.at)}</p>
							{/if}
						</div>

						{#if entry.role === "assistant"}
							{#if entry.reasoning.length > 0}
								<details class="mb-2">
									<summary class="is-size-7 has-text-grey">Reasoning</summary>
									<pre class="chat-pre">{entry.reasoning}</pre>
								</details>
							{/if}
							{#if entry.meta?.error !== undefined}
								<p class="notification is-warning is-light is-size-7 mb-2">{entry.meta.error}</p>
							{/if}
							{#if entry.text.length > 0}
								<div class="content is-small">{@html rendered[entry.index] ?? ""}</div>
							{/if}
							{#if entry.meta?.metrics !== undefined}
								<p class="is-size-7 has-text-grey mt-2">
									{entry.meta.metrics.totalTokens} tokens ·
									{(entry.meta.metrics.latencyMs / 1000).toFixed(1)}s ·
									{entry.meta.metrics.model}
								</p>
							{/if}
						{:else if entry.meta?.initial === true}
							<details>
								<summary class="is-size-7 has-text-grey">
									Initial request · {entry.meta.files?.length ?? 0} file(s)
								</summary>
								<pre class="chat-pre">{entry.text}</pre>
							</details>
						{:else if editingIndex === entry.index}
							<textarea class="textarea is-small" rows="5" bind:value={editingText}></textarea>
							<div class="buttons mt-2 mb-0">
								<button class="button is-small is-primary" onclick={() => void saveEdit()} disabled={$chatBusy}>
									Save &amp; regenerate
								</button>
								<button class="button is-small" onclick={() => (editingIndex = null)}>Cancel</button>
							</div>
						{:else}
							<div class="chat-user-text">{entry.text}</div>
							<button
								class="button is-small is-light mt-2"
								onclick={() => startEdit(entry)}
								disabled={$chatBusy}
							>
								Edit
							</button>
						{/if}
					</article>
				{/each}

				{#if $chatStreaming.active}
					<article class="box mb-3 chat-reply chat-streaming">
						<div class="is-flex is-justify-content-space-between mb-2">
							<p class="is-size-7 has-text-weight-semibold is-capitalized">assistant</p>
							<p class="is-size-7 has-text-grey">streaming…</p>
						</div>
						{#if $chatStreaming.reasoning.length > 0}
							<details open class="mb-2">
								<summary class="is-size-7 has-text-grey">Reasoning</summary>
								<pre class="chat-pre">{$chatStreaming.reasoning}</pre>
							</details>
						{/if}
						{#if $chatStreaming.text.length > 0}
							<div class="chat-user-text">{$chatStreaming.text}</div>
						{:else}
							<p class="is-size-7 has-text-grey">Waiting for the model…</p>
						{/if}
					</article>
				{/if}
			</div>

			{#if $chatError !== null}
				<article class="message is-danger is-small">
					<div class="message-body">{$chatError}</div>
				</article>
			{/if}

			<div class="field mt-4">
				<textarea
					class="textarea"
					rows="3"
					bind:value={draft}
					placeholder="Ask about this run… (Enter to send, Shift+Enter for a new line)"
					disabled={$chatBusy}
					onkeydown={onKeydown}
				></textarea>
			</div>
			<div class="buttons mb-0">
				<button
					class="button is-primary is-small"
					onclick={() => void send()}
					disabled={$chatBusy || draft.trim().length === 0}
				>
					Send
				</button>
				{#if $chatStreaming.active}
					<button class="button is-danger is-light is-small" onclick={() => epfSession.stopChat()}>
						Stop
					</button>
				{/if}
				<button
					class="button is-light is-small"
					onclick={() => void regenerate()}
					disabled={$chatBusy || transcript.length === 0}
				>
					Regenerate last
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.session-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		max-height: 32rem;
		overflow-y: auto;
	}

	.session-item {
		display: block;
		height: auto;
		white-space: normal;
		padding: 0.5rem 0.75rem;
	}

	.session-item-body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		word-break: break-all;
	}

	.chat-transcript {
		max-height: 34rem;
		overflow-y: auto;
		padding-right: 0.25rem;
	}

	.chat-prompt {
		background-color: var(--bulma-background);
		border: 1px solid var(--bulma-border-weak);
	}

	.chat-user-text,
	.chat-pre {
		white-space: pre-wrap;
		word-break: break-word;
		font-family: inherit;
	}

	.chat-pre {
		background-color: var(--bulma-background);
		color: var(--bulma-text);
		padding: 0.5rem;
		max-height: 18rem;
		overflow-y: auto;
		font-size: 0.75rem;
	}

	.chat-streaming {
		border-left: 3px solid var(--bulma-link);
	}
</style>
