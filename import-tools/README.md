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

## Uploading Base Files to Repositories
To upload base files (e.g., starter code, assignment templates) to all student repositories:

1. Place the files you want to upload in the `./repo_base_files` directory
2. The directory structure will be preserved when uploading
3. Run the script:
```bash
bun run upload-base-files
```

This will upload the files to the main branch of each student's repository. Existing files in the repository will be preserved, and only files present in `./repo_base_files` will be overwritten.

