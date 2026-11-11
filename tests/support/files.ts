import { relative } from "node:path";
import { files } from "../../src/sources/files.ts";
/** Проверка сохранности собственных тестовых данных без digest. */
export async function readTreeBytes(root: string): Promise<string> {
  return JSON.stringify(
    await Promise.all(
      (await files(root)).map(async (
        path,
      ) => [relative(root, path), Array.from(await Deno.readFile(path))]),
    ),
  );
}
