import { readFile, writeFile } from "node:fs/promises";

const workerTypesPath = new URL("../worker-configuration.d.ts", import.meta.url);
const generatedTypes = await readFile(workerTypesPath, "utf8");

// Wrangler emits broad ESLint directives that Obsidian's source-code review
// rejects, even though this declaration file is generated and not plugin code.
const sanitizedTypes = generatedTypes
	.replace(/^\/\* eslint-disable \*\/\r?\n/gm, "")
	.replace(/\s*\/\/ eslint-disable-line\s*$/gm, "");

if (sanitizedTypes !== generatedTypes) {
	await writeFile(workerTypesPath, sanitizedTypes);
}
