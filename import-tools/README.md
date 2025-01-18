# import-tools


To install dependencies:
```bash
bun install
```

To create repositories from class roster:
```bash
bun run setup-repos
```

To grant access to repositories based on team:
```bash
bun run add-collaborators
```

To import submission files from Canvas:
First need to create a `./submissions` directory and download the submissions from Canvas into that directory. Then run:
```bash
bun run import-submissions
```

This project was created using `bun init` in bun v1.1.43. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
