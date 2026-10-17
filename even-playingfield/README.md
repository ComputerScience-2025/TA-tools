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

Both `/tree/` (directory, downloaded recursively) and `/blob/` (single file) URLs are supported. Files land in the output directory with the requested directory prefix stripped.

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


## Development
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
