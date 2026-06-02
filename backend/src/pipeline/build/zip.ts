import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";

type ArchiverErrorLike = Error & { code?: string };

export async function zipDirectory(
  sourceDir: string,
  destZipPath: string,
  opts: { rootFolderName?: string } = {},
): Promise<{ byteSize: number }> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", (err) => reject(err));
    archive.on("error", (err: Error) => reject(err));
    archive.on("warning", (err: ArchiverErrorLike) => {
      if (err.code === "ENOENT") return;
      reject(err);
    });

    archive.pipe(output);
    // `false` puts the directory's contents at the zip root (the export.zip
    // case). A folder name nests them under that folder — required for a WP
    // plugin zip, whose contents must live under a top-level plugin folder.
    archive.directory(sourceDir, opts.rootFolderName ?? false);
    archive.finalize();
  });

  const s = await stat(destZipPath);
  return { byteSize: s.size };
}
