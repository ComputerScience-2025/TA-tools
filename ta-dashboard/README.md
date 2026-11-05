# TA Dashboard

SvelteKit app (Svelte 5 runes + Bulma) holding everything that needs a UI.

## Commands

```bash
bun install
bun run dev        # dev server
bun run build      # production build
bun run check      # svelte-check (types + a11y)
bun run preview    # preview the production build
```

## Pages

| Route | What it does |
|---|---|
| `/tools/comments-calculator` | Scores review comments against a rubric (GitHub API via Octokit, client-side) |
| `/tools/links-opener` | Bulk-opens links |
| `/tools/results-viewer` | Renders EPF output files from three sources: a live CLI API (`#api=…`), a URL-embedded file (`#name=…&comp=gzip&data=…`), or the browser workspace (`#source=workspace`) |
| `/apps/epf` | Runs EPF entirely in the browser: fetch a repo, upload files, edit the config, run workflows in a pseudo-shell console, read the outputs |

`/apps/epf` and `/tools/results-viewer` are client-only (`ssr = false`).

## EPF in the browser

- The EPF core and its browser platform live in `../even-playingfield/src`, imported through the `$epf` alias
  (declared in `svelte.config.js`; `vite.config.ts` allows the dev server to read outside the project root).
- `src/lib/epf/session.ts` owns the single `WebEPF` instance and exposes it as Svelte stores; `src/lib/epf/settings.ts`
  holds UI preferences. Both pages share the session, so navigating between them keeps the workspace.
- `src/lib/components/FileBrowser.svelte` and `src/lib/results/file-sources.ts` implement the three result sources listed above.
  Markdown is rendered through `dompurify`, because outputs can quote text from an untrusted repository.
- Files persist in IndexedDB through ZenFS. Storage limits (total, per file, source TTL) are configurable in the EPF page's
  Config tab; over the cap, the least recently used unpinned workspace is removed.
- "Clear outputs" (the Outputs tab, or `clear`/`rerun` in the console) deletes exactly the files runs recorded for that
  workspace, so fetched sources and the config stay. Deleting a whole workspace is a separate action in the Source tab.
- Secrets (GitHub PATs) stay in memory unless "remember on this device" is enabled. Turning "remember" off clears what was
  stored. Only the tab that owns the storage lock writes; every other tab mounts the same IndexedDB store read-only, so the
  saved files stay visible while writes are refused (the EPF page offers "Take over storage" once the owning tab closes).
- Testing workflows need a shell and therefore only run in the CLI.

## Deployment note

Because `$epf` points outside this directory, the deployed build must see both packages: set the Vercel project root to the
repository root (install/build commands `cd ta-dashboard && bun install && bun run build`), or the alias cannot resolve.
