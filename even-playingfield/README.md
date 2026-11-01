# Project Even-Playfield (E-PF)
AI-assisted responsible grading tool for programming assignments. A GPT-wrapper in CLI for CS graders.

## Usage
Make sure you have [Bun](https://bun.com) installed.
To run:
```bash
bunx --bun even-pf [config]
```

The `config` can be an absolute or relative path. Can also be a URL. 
If not specified, it will first try to get `EPF_CONFIG_URL` environment variable, then look for `epf.toml` in the current and the home directory.

If you're using the tool in a resource-constrained environment, you can use platform-specific executables like [even-pf-linux-x64](https://www.npmjs.com/package/even-pf-linux-x64).

### Downloading files
The downloader is a separate subcommand (independent of `epf.toml`) that pulls files from a remote source into a local directory. It uses a plugin system, so additional remotes can be added over time.

```bash
even-pf download github https://github.com/user/repo/tree/branch_name/dir_name
```

Both `/tree/` (directory, downloaded recursively), `/blob/` (single file) and `/pull/<n>` (a pull request's head commit) URLs are supported. Files land in the output directory with the requested directory prefix stripped.

Flags:

| Flag | Default | Description |
|---|---|---|
| `-o, --output <dir>` | `.` | Directory to write into |
| `--skip-existing` | off (overwrite) | Skip files that already exist |
| `--concurrency <n>` | `5` | Max parallel file downloads |
| `--dry-run` | off | List files without writing anything |
| `--token <value>` | — | Override the remote's token env var |

Credentials are read from environment variables, not `epf.toml`:

- `EPF_DOWNLOAD_GITHUB_PAT` — GitHub personal access token. Optional; required for private repositories.

## Chat sessions

Every successful analysis run is recorded as a JSON chat session, so the conversation can be continued later instead of
treating the markdown output as final.

- CLI: `~/.even-pf/sessions/<id>.json`
- Browser: `/epf/home/sessions/<id>.json` (outside the workspace tree, so quota cleanup never removes it)

A session stores the resolved system prompt, the exact messages sent to the model, and the assistant reply **including its
reasoning parts and provider metadata**. That is what lets a follow-up turn send the assistant's thinking back to the model
unchanged (Anthropic signatures, OpenAI reasoning ids, and so on). The model is fixed to the one the workflow used; changing
`[llm.models.*]` settings affects later turns, but a missing model is reported instead of silently switching.

```toml
[sessions]
enabled = true            # record a session for every analysis run
retain_reasoning = true   # keep reasoning parts for replay (set false for providers that reject them)
```

CLI:

```bash
even-pf chat              # open the most recent session, then return to the normal REPL on exit
even-pf chat <SESSION>    # open a specific session (id or unique prefix)
```

In the REPL, `chat` lists this workspace's sessions (`chat --all` for every workspace) and `chat <id-or-prefix>` enters
chat mode. Inside chat, plain text is sent to the model, `:regen` regenerates the last reply, `:reasoning` toggles thinking
output, `:help` lists commands, and `exit`/`:q` returns to the `epf>` prompt. Streaming runs are printed as they arrive.

In the browser, the `/apps/epf` **Outputs → Chats** tab lists the workspace's sessions, streams replies, and lets you edit a
user message (which deletes every later turn and regenerates), regenerate the last reply, stop a stream, or delete a session.

## Running in the browser

The same core runs in a web page through `src/hosts/web-host.ts` (`WebEPF`), which the `ta-dashboard` app consumes at `/apps/epf`.

```ts
import { WebEPF } from "./src/hosts/web-host.ts";

const epf = await WebEPF.create();
await epf.fetchSource({ kind: "url", url: "https://github.com/owner/repo/tree/main/src" });
await epf.applyConfigText(tomlText);
await epf.runWorkflows();
await epf.executeCommand("status");   // the same dispatcher the CLI REPL uses
```

What differs from the CLI:

| Area | Behaviour |
|---|---|
| Filesystem | `@zenfs/core`: IndexedDB (persistent) with an in-memory fallback when storage is blocked |
| Workspaces | Each fetched repository / upload target is a workspace under `/epf/workspaces/<slug>`; the active one plays the role of the CLI's `--dir` |
| Storage limits | Per-file cap (8 MiB), total cap (128 MiB), 7-day TTL for unpinned workspaces. Over the cap, the least recently used unpinned workspace is removed; pinned and active workspaces are never touched |
| Config | Explicit source → `EPF_CONFIG_URL` → `epf.toml` in the active workspace → the durable library default (`/epf/home`). Workspace files and URLs are remembered across reloads; pasted configs are not remembered as the engine source |
| Environment | A browser has none: values are set in the web UI (see `src/util/env-vars.ts`). Secrets stay in memory unless "remember" is enabled |
| Testing workflows | Unavailable — they need a shell. They fail fast with a clear message; run them with the CLI |
| Outputs | Each finished run's filenames are recorded per workspace, so `clear`/`rerun` (and the dashboard's "Clear outputs") delete exactly those files and nothing else. `clearWorkspace(path)` is the explicit delete-everything action |
| Chat sessions | Each analysis run is stored under `/epf/home/sessions`; the Outputs → Chats tab streams follow-ups and keeps reasoning for replay. Chat needs write access (the results viewer is read-only) |
| Multiple tabs | The first tab takes a Web Locks lock for writing; other tabs run read-only (the results viewer reads the persisted store) or memory-only |
| Provider calls | Direct from the browser, so the provider endpoint must allow CORS. Anthropic additionally refuses cross-origin requests unless the provider sets `headers = { "anthropic-dangerous-direct-browser-access" = "true" }`; any `[llm.providers.*] headers` are passed through to the SDK |

API keys live in the config you load. Saving a config *into* a workspace or the library writes the TOML — including its
`api_key` values — to browser storage, so use that for configs you are willing to keep in this browser. Applying a config for
this session does not make the text the remembered engine source, but the interactive editor still autosaves its draft (also
including API keys) so a refresh does not lose work. The results viewer's `#source=workspace` mode lists the recorded outputs,
so fetched repositories and configs never appear as results.

### Interactive config editor

The dashboard's Config tab edits the whole config through a form generated from `ConfigSchema`, not a free-form TOML textarea:

- **Form**: add / delete / reorder / duplicate array items, record entries and string-list values. Renaming a provider or model
  rewrites the references that point at it, and deleting a referenced one is refused. Provider/model fields are selects, prompts
  are textareas, and `seed` stays unset (a fresh timestamp per run) unless explicitly pinned.
- **TOML preview**: read-only output of the exact serializer Save uses. Comments and the original formatting are normalized.
- **Library**: config files live in `/epf/home` (multiple named files, renameable, with one optional default). Library files
  survive workspace cleanup; a workspace with no config falls back to the library default, so a config does not need to be
  copied into every new workspace. "Copy to workspace" remains available for a local copy.
- **Drafts**: unsaved edits are written to `/epf/home/.editor/drafts.json` in IndexedDB (debounced) and restored after a
  refresh/crash. A changed source is reported as a conflict instead of being overwritten.
- **Migration**: opening an outdated config shows the registered migrations. Nothing is rewritten until the user chooses to
  migrate and then saves; newer-than-build configs open read-only.

Saving is explicit: **Save** writes the file the editor was opened from (library or workspace), **Save as** writes to a chosen
destination, and **Apply for this session** changes only the engine in this tab. `WebEPF.saveConfigToPath()` is the
path-explicit save used by the editor; `saveConfigToCurrentSource()` remains the engine-source convenience.

The browser platform sets `Platform.homeDir` to `/epf/home` and `Platform.homeConfigName` to the selected library default, so
`resolveConfigSource()` can find it on a fresh page. The CLI keeps its OS home directory and the conventional `epf.toml`.

## Development

### Platform layer

Core code (`engine/`, `workflow/`, `util/`) must run under Bun *and* in a browser, so it only touches the outside world through
`src/platform/types.ts` (`VirtualFileSystem`, `EnvProvider`, `ShellRunner`, `Logger`, `toml`, `homeDir`, `homeConfigName`):

```
src/platform/
├── types.ts, path.ts, glob.ts   interfaces + shared helpers (platform-agnostic)
├── bun/                         node:fs, process.env, Bun $, console/chalk, Bun.TOML
└── web/                         ZenFS, localStorage env, log ring buffer, smol-toml
```

- `src/platform/boundary.test.ts` fails if a core file imports `bun`, `node:*`, or a DOM global.
- `bun run check` type-checks with Bun types; `bun run check:web` re-checks the browser files with DOM libs and no Bun types.
- Globbing goes through `src/platform/glob.ts` (picomatch + a VFS walk) so patterns match identically on both targets.
- `bun test` covers the VFS contract against both implementations, the glob parity with `Bun.Glob`, the storage policy, and the
  web host end to end (GitHub API and provider responses stubbed).


To install dependencies:
```bash
bun install
```

To install as a tool globally:
```bash
bun link -g e-pf
```

Make sure you have a config file in your home or current directory. Alternatively, you can set environment variable `EPF_CONFIG_URL`.

This project was created using `bun init` in bun v1.3.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

### Publishing
After making changes, you might want to bump the version.
```bash
bun run bump <semver>
```

Build the executable:
```bash
bun run build:all 
```

Then publish to npm:
```bash
bun run publish:all
```
Do not run `bun publish` directly, the executables are distributed as separate packages and need to be published separately.

## Specs
### File-viewer Frontend
In consideration of the tool might be running at a remote server, for easily viewing the Markdown files, we will use a simple file-viewer frontend.
Data being sent to the frontend will be as encoded as an URL, using the following format:
```
https://yourfrontend.com/#name=...&comp=gzip&data=...
```
The `data` field is base64-encoded using compression algorithm specified in `comp` field. The frontend will decode the data and display it as a Markdown file.
