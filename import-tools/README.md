# import-tools

Make sure you have installed [Bun](https://bun.sh) in your system.

To install dependencies:
```bash
bun install
```

## Setup for Each Quarter
Parse Canvas' roster
For `section` use the format "25Fall-01"
```bash
bun run roster-convert
```

To create repositories from class roster:
```bash
bun run setup-repos
```

To grant access to repositories based on team:
```bash
bun run add-collaborator
```

Finally, export the roster with repository links for spreadsheet
```bash
bun run roster-export
```

## For each assignment
To import submission files from Canvas:
First need to create a `./submissions` directory and download the submissions from Canvas into that directory. Then run:
```bash
bun run import-submissions
```