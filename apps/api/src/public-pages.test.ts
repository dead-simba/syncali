import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const apiPublicPages = ["device.html", "signin.html", "signup.html", "vaults.html"] as const;

describe("API public pages", () => {
	it.each(apiPublicPages)("links the Synch logo on %s to the marketing site", async (page) => {
		// `.pathname` stays percent-encoded, so a checkout path containing a
		// space resolves to a filename that does not exist. Decode it rather
		// than passing the URL itself: this project's ambient Workers `URL` is
		// nominally distinct from node's, so `readFile(url)` fails to typecheck.
		const html = await readFile(
			decodeURIComponent(new URL(`../public/${page}`, import.meta.url).pathname),
			"utf8",
		);

		expect(html).toContain('<a href="https://synch.run/"');
		expect(html).not.toContain('<a href="/"');
	});
});
