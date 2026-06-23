# AGENTS.md — TA-tools

## Repository overview

Four independent packages in this directory. Each has its own `package.json`, `tsconfig.json`, `bun.lock`, and scripts. There is no workspace tool; run `bun install` inside each package individually. **Bun** is the only runtime and package manager — never use `npm`, `pnpm`, or `yarn`.

| Package | Type | Purpose | Dev entry | Build |
|---|---|---|---|---|
| `import-tools/` | GitHub automation scripts (CLI) | Upload files downloaded from Canvas to GitHub repos | `src/*.ts` via `bun run <script>` | — |
| `even-playingfield/` | Compiled CLI binary | The AI tool for analyzing submissions | `src/cli.ts` | `bun build --compile` |
| `ta-dashboard/` | SvelteKit + Svelte 5 + Bulma | Everything that needs an interactive web interface | `src/routes/` (SvelteKit) | `bun run build` |
| `epf-eval/` | Benchmark harness (git submodule) | Proprietary evaluation benchmark for `even-playingfield` | `src/scripts/*.ts` via `bun run script:<name>` | — |

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
- `bun run build-dev` — compile to `build/epf.exe` (current platform)
- `bun run build:all` — cross-compile for linux-x64/arm64, windows-x64, darwin-x64/arm64
- `bun run config-gen` — regenerate `epf.example.toml` from Zod schema defaults
- `bun run bump <semver>` — bump version in root + all 5 platform sub-packages
- `bun run publish:all` / `publish:dry` — publish all to npm

Config: TOML, loaded from `--config` CLI arg → `EPF_CONFIG_URL` env var → `epf.toml` in cwd/home. Validated with Zod v4 schemas in `src/util/config-schema.ts`.

Key dependencies: `ai` (Vercel AI SDK core), `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `chalk`, `smol-toml`, `zod-defaults`.

LLM providers are configured under `[llm.providers.*]`. Each provider must declare `sdk`, `endpoint`, and `api_key`; the `api_key` is intentionally required and the SDK's env-var fallback is explicitly blocked.

Distribution: Published as npm package `even-pf`. Platform-specific native binaries under `npm/even-pf-{platform}/`. `bin/even-pf.js` is the JS launcher that detects platform and spawns the correct binary.

### `ta-dashboard/`

Commands (run in `ta-dashboard/`):
- `bun run dev` — start Vite dev server
- `bun run build` — production build
- `bun run check` — `svelte-kit sync && svelte-check` (type checking)
- `bun run preview` — preview production build

SvelteKit conventions:
- Svelte 5 **Runes API** only: `$state()`, `$derived()`, `$effect()`, `$props()`, `{@render children?.()}`. Never use `export let`, `$:`, `on:click`.
- Use `$lib/` alias for imports from `src/lib/` (never cross `src/lib` with relative paths).
- SSR is disabled for `/tools/comments-calculator` (`+page.js` has `export const ssr = false`).
- Pages that call GitHub API (`comments-calculator`) do so client-side via Octokit — PAT is read from a persisted Svelte store.

Styling: Bulma CSS classes. Toast notifications via `@zerodevx/svelte-toast`. Markdown rendering via `marked`.

### `epf-eval/`

Commands (run in `epf-eval/`):
- `bun run script:run-suite` — run EPF over the dataset and collect outputs + telemetry
- `bun run script:score` — score captured outputs with LLM-as-judge and metrics
- `bun run script:variants` — generate deterministic synthetic variants (static set)
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

Note: since it is a git submodule, need to check for uncommitted changes separately for reviewing.

---

## Toolchain notes

- **No formatter** is configured — follow the style rules below manually.
- `tsconfig.json` in every package has `strict: true`. Never disable it. `verbatimModuleSyntax` requires `import type` for type-only imports.
- `even-playingfield` builds compile with `Bun.build({ target: "bun", compile: true })`. Version stamp is injected via `define: { EPF_VERSION }`.
- Each `.github/copilot-instructions.md` contains package-specific guidance that is subsumed by this file.

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
