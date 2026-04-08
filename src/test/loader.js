/**
 * ESM loader: maps .js imports → .ts when the .ts file exists in src/.
 * Required because source files use NodeNext-style .js extensions,
 * but we run tests directly on .ts with --experimental-strip-types.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js")) {
    const tsSpecifier = specifier.slice(0, -3) + ".ts";
    try {
      const result = await nextResolve(tsSpecifier, context);
      const filePath = fileURLToPath(result.url);
      if (existsSync(filePath)) return result;
    } catch {
      // fall through to original specifier
    }
  }
  return nextResolve(specifier, context);
}
