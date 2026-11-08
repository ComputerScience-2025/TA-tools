# AGENTS.md — TA-tools

## Repository overview

Four independent packages in this directory. Each has its own `package.json`, `tsconfig.json`, `bun.lock`, and scripts. There is no workspace tool; run `bun install` inside each package individually. **Bun** is the only runtime and package manager — never use `npm`, `pnpm`, or `yarn`.

| Package | Type | Purpose | Dev entry | Build |
|---|---|---|---|---|
| `import-tools/` | GitHub automation scripts (CLI) | Upload files downloaded from Canvas to GitHub repos | `src/*.ts` via `bun run <script>` | — |
| `even-playingfield/` | CLI binary **and** browser core | The AI tool for analyzing submissions | `src/hosts/cli-host.ts` (CLI), `src/hosts/web-host.ts` (web) | `bun build --compile` |
| `ta-dashboard/` | SvelteKit + Svelte 5 + Bulma | Everything that needs an interactive web interface | `src/routes/` (SvelteKit) | `bun run build` |
| `epf-eval/` | Benchmark harness (git submodule) | Proprietary evaluation benchmark for `even-playingfield` | `src/scripts/*.ts` via `bun run <script>` | — |

---

## Package reference

### `import-tools/`

**Required:** `.env` file with `GITHUB_TOKEN`, `GITHUB_USERNAME`, `GITHUB_COMMIT_EMAIL`, `IMPTTOOLS_GH_ORG`.

Scripts (run via `bun run <name>` in `import-tools/`):
- `setup-repos` — batch-create GitHub repos from class roster
- `add-collaborator` — grant repo access by team
- `upload-files` — push submission files to feature branches + create PRs
- `upload-base-files` — push starter code to main branch (via isomorphic-git)
- `close-prs` — bulk-close PRs matching a title filter
- `roster-convert` — parse Canvas CSV roster → internal `roster.json`
- `roster-export` — export roster with repo links for spreadsheets
- `make-dummy-files` — generate placeholder submission files per student

Key dependencies: `octokit` (GitHub API), `isomorphic-git`, `csv-simple-parser`.

### `even-playingfield/`

Commands (run in `even-playingfield/`):
- `bun run start` — run in dev (uncompiled)
- `bun run build:dev` — compile to `build/epf.exe` (current platform)
- `bun run build:all` — cross-compile for linux-x64/arm64, windows-x64, darwin-x64/arm64
- `bun run config-gen` — regenerate `epf.example.toml` from Zod schema defaults
- `bun run bump <semver>` — bump version in root + all 5 platform sub-packages
- `bun run publish:all` / `publish:dry` — publish all to npm

Testing:
- `bun test` — unit + contract tests (run after any change to the core or platform layer)
- `bun run check` — type check (Bun environment)
- `bun run check:web` — type check with DOM libs and **no** Bun/Node types, which enforces the platform boundary

### Platform layer (why it exists)

The core (`engine/`, `workflow/`, `util/`) must run under Bun *and* in a browser. It reaches the outside world only through
`src/platform/types.ts`:

| Interface | Bun | Browser |
|---|---|---|
| `VirtualFileSystem` | `BunFileSystem` (node:fs) | `ZenFileSystem` (@zenfs/core + IndexedDB) |
| `EnvProvider` | `process.env` | `localStorage` JSON |
| `ShellRunner` | Bun `$` | unavailable (testing workflows fail fast) |
| `Logger` | console + chalk | ring buffer + xterm renderer |
| `toml` | `Bun.TOML.parse` | `smol-toml` |

Rules:
- Core files must not import `bun`, `node:*`, or DOM globals. `src/platform/boundary.test.ts` fails the test suite if they do
  (it scans `engine/`, `workflow/`, `util/`, `download/`, `command-handler.ts`, and the shared platform helpers).
- Globbing goes through `src/platform/glob.ts` (picomatch + a VFS walk) so CLI and browser match identically.
- Paths inside the platform layer are POSIX-style; relative paths resolve against `fs.root` (Bun: cwd, browser: active workspace).
- Hosts wire platforms: `hosts/local-api-host.ts` (Bun/CLI/`epf-eval`) and `hosts/web-host.ts` (`WebEPF`).
- `download/` writes through the VFS, so the GitHub remote serves both the CLI and the browser. Non-fatal notes reach the user
  through `PlanOptions.onNote` (the CLI leaves it out and gets `console.warn`).
- Output files are recorded, not guessed: the engine reports each run's filenames, the browser host keeps them per workspace in
  `WebState.outputs`, and "clear outputs" deletes exactly those names. Never delete a directory's files by pattern.

Config: TOML, loaded from `--config` CLI arg → `EPF_CONFIG_URL` env var → `epf.toml` in cwd/home. In the browser the
workspace check comes before a durable home library (`Platform.homeDir`), whose selected file is
`Platform.homeConfigName` (`WebState.home.defaultConfig`). Validated with Zod v4 schemas in
`src/util/config-schema.ts`; `CURRENT_CONFIG_VERSION` and the registry in `src/util/config-migrations.ts` are shared by the
CLI `migrate` command and the browser editor. Env-var names live in `src/util/env-vars.ts` (the web UI renders that registry).

Remote URL configs are treated as live. `loadRawConfig` leaves caching to the browser/CDN (normal HTTP cache semantics), and
`WebEPF.runWorkflows()` re-fetches before each run. A failed refresh keeps the last loaded config and surfaces
`RemoteConfigStatus` (last fetch, last change, error) to the Config panel; opening the Config tab also refreshes. The engine's
`applyConfig()` updates a same-source config without replacing the `Engine` (results and listeners survive), and `reload` emits
`config-reloaded` so the host's text cache stays in step.

S3-compatible upload is a single-file save, not a workspace export. `Save as → S3 bucket` uses `@aws-sdk/client-s3` (lazy-loaded,
with `@smithy/fetch-http-handler` so Bun and browsers share the same fetch path). Addressing style is explicit and required, never
inferred: `EPF_S3_ADDRESSING_STYLE=path` (`endpoint/bucket/key`) or `virtual` (`bucket.endpoint/key`). Use `virtual` for B2 and
AWS, `path` for R2/MinIO. Settings are the `EPF_S3_*` variables in `env-vars.ts` (endpoint, region, bucket, optional prefix,
access key ID, secret, addressing style, optional public base URL); there is no session-token variable. Saves use an optimistic
ETag guard instead of S3 conditional writes: the object is `HEAD`ed first and its ETag is compared with the ETag captured when the
config was read (a create must not replace an existing key), so `putS3Object` sends no `If-Match` / `If-None-Match` — B2 and
other providers reject those with `501 NotImplemented`. The check is not atomic: a write that lands between the `HEAD` and the
`PUT` is not detected, and `force` skips it. The bucket must allow CORS for `PUT`/`HEAD`, the SDK's headers, and expose `ETag`.
`testS3Connection()` performs a harmless sentinel `HEAD` so the UI can verify credentials and preflight before saving.

Key dependencies: `ai` (Vercel AI SDK core), `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@aws-sdk/client-s3`, `@smithy/fetch-http-handler`, `chalk`, `smol-toml`, `zod-defaults`.

LLM providers are configured under `[llm.providers.*]`. Each provider must declare `sdk`, `endpoint`, and `api_key`; the `api_key` is intentionally required and the SDK's env-var fallback is explicitly blocked.

Distribution: Published as npm package `even-pf`. Platform-specific native binaries under `npm/even-pf-{platform}/`. `bin/even-pf.js` is the JS launcher that detects platform and spawns the correct binary.

### `ta-dashboard/`

Commands (run in `ta-dashboard/`):
- `bun run dev` — start Vite dev server
- `bun run build` — production build
- `bun run check` — `svelte-kit sync && svelte-check` (type checking)
- `bun test` — unit tests for the pure helpers (routes, config sub-routes, shared-config hash, draft policy)
- `bun run preview` — preview production build

SvelteKit conventions:
- Svelte 5 **Runes API** only: `$state()`, `$derived()`, `$effect()`, `$props()`, `{@render children?.()}`. Never use `export let`, `$:`, `on:click`.
- Use `$lib/` alias for imports from `src/lib/` (never cross `src/lib` with relative paths).
- SSR is disabled for `/tools/comments-calculator` and `/apps/epf` (`+layout.js` under the EPF route has `export const ssr = false`).
- Pages that call GitHub API (`comments-calculator`) do so client-side via Octokit — PAT is read from a persisted Svelte store.

Browser EPF integration:
- `/apps/epf` is a layout plus four real routes: `source`, `config`, `console`, `outputs`. `apps/epf/+layout.svelte` owns the
  session bootstrap, chrome, banners and tab navigation; `/apps/epf` itself redirects to `source` (preserving search and hash).
  Route paths and labels live in `src/lib/epf/routes.ts` — link through `epfHref()`/`configHref()` instead of inline strings.
  `config` is itself a nested layout with four sub-routes (`editor`, `library`, `environment`, `storage`); `/apps/epf/config`
  redirects to `editor`. The config layout owns the source/version tags, the remote-config banner (refreshed once per entry)
  and the section navigation. It also opens the engine's config in the singleton editor (`ConfigEditor.openActive`) and
  reconciles that source's saved draft (`ConfigEditor.reconcileDraft`) once per entry, so the tags and the Library's "open"
  marker are correct on every Config sub-route; the Editor page never replaces an in-memory document. The Config root
  redirects to `editor`; there is no query-string section state.
- EPF-only components live next to the route that uses them (colocated with `+page.svelte`, which SvelteKit ignores); `$lib/components`
  is reserved for UI shared across routes (for example `FileBrowser.svelte`, also used by the results viewer). Route pages may
  import `$app/state`/`$app/navigation`; components under `$lib/components` must not.
- A tab page is **cold-mountable**: it may be unmounted at any time by a route change and must render correctly from a fresh
  mount. State ownership: URL for navigable state, IndexedDB for durable state, a module rune store
  (`source-form.svelte.ts`, `config-editor.svelte.ts`) for in-progress input, component state for transient feedback.
- `$epf` is a SvelteKit alias for `../even-playingfield/src` (see `svelte.config.js`); `vite.config.ts` allows the dev server to serve
  files outside the project root, and declares the dynamically imported dependencies in `optimizeDeps`.
- `src/lib/epf/session.ts` is the module-level singleton owning the `WebEPF` instance and exposing it as Svelte stores.
  `ensure()` creates a read-write session; `ensure({ writeAccess: false })` (the results viewer) reads the persisted store
  from another tab without taking the write lock. Internal refreshes use `requireSession()`—never `ensure()`—or they deadlock.
- A read-write session owns the storage lock and persists; every other tab (a second EPF tab, the results viewer) mounts the
  same IndexedDB store **read-only** — never memory-only — so the saved files stay visible. Writes are refused with
  `writeBlockedBy` (`"viewer"` | `"another-tab"`), the EPF page shows a banner with "Take over storage" once the owning tab
  closes, and only the owner writes the `localStorage` state blob (`WebStateStore`/`WebEnvProvider` take `{ persist: false }`).
  `ensure()` must never swap a read-only session for a new one while another tab holds the lock
  (`isStorageLockFree()` in `platform/web/storage-lock.ts`).
- `src/lib/components/FileBrowser.svelte` + `src/lib/results/file-sources.ts` serve all three result sources: live API (`#api=`),
  URL hash (`#name=&comp=&data=`), and the browser workspace (`#source=workspace`, which lists the recorded outputs). Rendered
  markdown is sanitized with `dompurify` before `{@html}`, because a fetched repository's files are untrusted input.
- The Config tab is an interactive editor, not a textarea. `src/lib/epf/config-editor.svelte.ts` owns the raw parsed document,
  validation, preview, dirty tracking and draft autosave; `apps/epf/config/ConfigNode.svelte` renders the tree from
  `util/config-form-schema.ts` (derived from `ConfigSchema`), and `apps/epf/config/library/+page.svelte` manages the home
  library + workspace config picker. Editing operations live in `util/config-object.ts`; keep them pure and cover them with
  `bun test` in `even-playingfield`.
- The library is `/epf/home/<name>.toml`, outside `/epf/workspaces`, so quota/TTL cleanup never removes it. A workspace with no
  config falls back to the selected library default (or `epf.toml`/a single file). `WebEPF.saveConfigToPath()` is the
  path-explicit save the editor uses; do not save through the engine's current source when the editor is on a different file.
- Editor drafts (including API keys) are stored in `/epf/home/.editor/drafts.json` in IndexedDB, keyed by source, and restored
  with a base-hash conflict check. Applying/saving/discarding bumps a draft epoch so an in-flight autosave cannot resurrect a
  stale draft. Opening an outdated config asks before migrating; the file is only rewritten on save.
- Config file lists: `detectConfigCandidates()` is the auto-adopt priority list (`epf.toml`, `eval/epf.toml`);
  `listWorkspaceConfigFiles()` is the broader picker (top-level `*.toml` + `eval/*.toml`). Keep the two distinct.
- EPF deps are version-pinned in `ta-dashboard/package.json` to match `even-playingfield`; keep them in step.

Styling: Bulma CSS classes. Toast notifications via `@zerodevx/svelte-toast`. Markdown rendering via `marked`.

### `epf-eval/`

Commands (run in `epf-eval/`):
- `bun run run-suite` — run EPF over the dataset and collect outputs + telemetry
- `bun run score` — score captured outputs with LLM-as-judge and metrics
- `bun run variants` — generate deterministic synthetic variants (static set)
- `bun run check` — type check with `bun x tsc --noEmit`

Dataset layout:

```text
dataset/v1/<case>/
├── src/            # student source files
└── eval/
    ├── case.toml   # case metadata, file globs, prompt replacements
    ├── gold.toml   # expected issues / rubric
    └── epf.toml    # per-case EPF config
```

Shared code: reuses `../even-playingfield/src/util/llm.ts` (Vercel AI SDK) via its instance-scoped `LlmClient`. Phase 2 added an in-process `EPF`/`Engine` entry point for richer telemetry; Phase 3 harness drives it directly with `EPF.create()` instead of spawning `cli-host.ts`.

Evaluation criteria are stored in TOML files under each case's `eval/` directory and aggregated by the bench harness. The LLM-as-judge uses OpenAI-compatible endpoints only.

The harness imports `EPF` from `even-playingfield/src/hosts/local-api-host.ts`, so that class, its `EPFOptions`, and
`WorkflowRunResult` are a stable contract — refactors must keep them working (`bun run check` in `epf-eval` catches drift).

Note: since it is a git submodule, need to check for uncommitted changes separately for reviewing.

---

## Toolchain notes

- **No formatter** is configured — follow the style rules below manually.
- `tsconfig.json` in every package has `strict: true`. Never disable it. `verbatimModuleSyntax` requires `import type` for type-only imports.
- `even-playingfield` builds compile with `Bun.build({ target: "bun", compile: true })`. Version stamp is injected via `define: { EPF_VERSION }`.
- Each `.github/copilot-instructions.md` contains package-specific guidance that is subsumed by this file.

## Dependencies added for the browser target

| Package | Where | License | Why |
|---|---|---|---|
| `picomatch` | `even-playingfield` (runtime), `ta-dashboard` | MIT | Glob matching shared by CLI and browser |
| `@zenfs/core`, `@zenfs/dom` | `even-playingfield` (dev), `ta-dashboard` | **LGPL-3.0-or-later** | Browser filesystem (in-memory + IndexedDB backends) |
| `fake-indexeddb` | `even-playingfield` (dev) | MIT | Tests the IndexedDB backend without a browser |
| `@xterm/xterm`, `@xterm/addon-fit`, `xterm-readline` | `ta-dashboard` | MIT | The `/apps/epf` pseudo-shell console |
| `dompurify` | `ta-dashboard` | **MPL-2.0 OR Apache-2.0** | Sanitizes rendered markdown (results can come from an untrusted repository) |
| `@aws-sdk/client-s3` | `even-playingfield` (runtime), `ta-dashboard` | Apache-2.0 | S3-compatible config uploads; lazy-loaded only when saving |
| `@smithy/fetch-http-handler` | `even-playingfield` (runtime), `ta-dashboard` | Apache-2.0 | Makes the S3 SDK use `fetch` in Bun and the browser (and lets tests stub it) |

The bundled web graph is ~90 KB gzip for storage + glob and ~155 KB gzip with the terminal; it is loaded only on `/apps/epf`
through dynamic imports. The S3 SDK is a separate lazy chunk fetched only when "Save as → S3 bucket" is used. Note the LGPL
dependency if the dashboard is ever served publicly (source-availability applies).

---

## Code Style

These rules apply to the source code in the three packages listed above. They do **not** apply to `.agents/skills/`, `node_modules/`, or external reference materials.

### Formatting
- Double quotes for all strings (TypeScript, JavaScript, Svelte `<script>`, Python).
- 4-space indentation.
- Semicolons at end of every statement.
- Curly braces required for all `if`/`else`/`for`/`while` branches. Avoid single-line blocks.
- No formatter is configured; follow these rules manually.
- Do not remove existing comments unless explicitly asked.

### Imports
- Sort imports in this order with a blank line between groups:
  1) Built-in / runtime (e.g. `bun`, `node:fs`)
  2) Third-party packages (e.g. `elysia`, `svelte/store`)
  3) Local modules (e.g. `$lib/stores.ts`, `./auth.service.ts`)
- Use named imports where possible; avoid default imports unless required.
- In frontend code, use the `$lib/` alias instead of relative paths that cross `src/lib`.
- Include the explicit `.ts` extension in local imports.

### TypeScript
- `strict: true` is enforced in all `tsconfig.json` files; never disable it.
- Always annotate types explicitly; avoid `any`.
- Use `type` for local object shapes and `export type` for shared types.
- Use `interface` only when declaration merging is intentional.
- Prefer union literals over `enum` for simple flags; use string enums when values are serialized.

#### Naming Conventions
- Variables/functions: `camelCase`.
- Classes/components: `PascalCase`.
- Module-level constants: `UPPER_SNAKE_CASE`.
- Enums: `PascalCase` names and members.
- JSON/DB fields: `snake_case`.
- Files: `kebab-case` for utilities; SvelteKit route conventions for routes.
- Preserve capitalization in abbreviations (ID, URL) in camelCase/PascalCase. For example, "userID", not "userId".

### Enums and Constants
- Use string enums and named constants; avoid magic strings/numbers.
- Define enums in the feature model file and export them.
- Share enum/string literals across the system via exports, do not duplicate.

### Error Handling
- Fast-fail patterns: `boolean` for success/failure or `T | null` for not-found.
- Only `throw` for programming errors (invalid arguments, impossible states).
- Never swallow errors silently.
- In Elysia handlers, use framework error responses, not `throw`, for HTTP errors.

### TypeBox Schemas and Types
- Define the schema first, then derive the type via `Static<typeof Schema>` to avoid drift.

### Package Management
- Use `bun` for package management and scripts.
- Do not modify package manifest files (`package.json`) manually; use `bun add` and `bun remove` to manage dependencies.
- Prefer runtime's built-in features rather than adding dependencies; justify any new dependency with a clear need and minimal footprint.

### Functionality Expectations
- Errors that cause core operations to fail should display clear indications in the UI and log details for debugging.
- No transition animations or visual effects are required; focus on functionality and clarity.
