import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toPosixPath } from "../path.ts";
import { describeVfsContract } from "../vfs-contract.ts";
import { BunFileSystem } from "./bun-fs.ts";

describeVfsContract("BunFileSystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "epf-bun-fs-"));
    return {
        fs: new BunFileSystem(toPosixPath(dir)),
        cleanup: async () => {
            await rm(dir, { recursive: true, force: true });
        },
    };
});
