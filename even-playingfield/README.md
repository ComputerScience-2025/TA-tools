# Project Even-Playfield (E-PF)
AI-assisted responsible grading tool for programming assignments. A GPT-wrapper in CLI for CS graders.

## Usage
Make sure you have [Bun](https://bun.com) installed.
To run:
```bash
bunx even-pf [config]
```

## Development
To install dependencies:
```bash
bun install
```

To install as a tool globally:
```bash
bun link
```

Make sure you have a config file in your home or current directory. Alternatively, you can set environment variable `EPF_CONFIG_URL`.

This project was created using `bun init` in bun v1.3.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Specs
### File-viewer Frontend
In consideration of the tool might be running at a remote server, for easily viewing the Markdown files, we will use a simple file-viewer frontend.
Data being sent to the frontend will be as encoded as an URL, using the following format:
```
https://yourfrontend.com/#name=...&comp=gzip&data=...
```
The `data` field is base64-encoded using compression algorithm specified in `comp` field. The frontend will decode the data and display it as a Markdown file.
