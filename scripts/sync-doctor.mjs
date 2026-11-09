#!/usr/bin/env node
/**
 * pnpm sync:doctor - how every device is syncing, in one report.
 *
 * Reads three things and judges each device with the same rules the plugin's
 * Devices view uses (apps/obsidian-plugin/src/sync/health/device-verdict.ts,
 * loaded directly - Node strips its types):
 *
 *   1. The server's own counters, D1 vault_sync_status.
 *   2. Each device's latest report, D1 vault_device_report. The readable half
 *      only: versions, cursors, times, counts. No file names.
 *   3. The decrypted reports a laptop's plugin keeps in
 *      <vault>/.obsidian/plugins/syncali/device-reports.json, which carry the
 *      file names and error messages. Only readable on a device with the key.
 *
 * Usage: pnpm sync:doctor [--vault <path-to-vault>]...
 * Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) for the remote D1 queries.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assessDevice,
	compareDeviceFiles,
	describePlatform,
	formatDate,
	formatDuration,
} from "../apps/obsidian-plugin/src/sync/health/device-verdict.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(REPO_ROOT, "apps/api");
const D1_NAME = "synch-db";
const STALE_LOCAL_COPY_MS = 60 * 60 * 1000;

function queryD1(sql) {
	let stdout;
	try {
		stdout = execFileSync(
			"pnpm",
			["-s", "exec", "wrangler", "d1", "execute", D1_NAME, "--remote", "--json", "--command", sql],
			{ cwd: API_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const detail = String(error.stderr || error.stdout || error.message);
		if (/not logged in|auth/i.test(detail)) {
			throw new Error("wrangler is not logged in. Run `pnpm -C apps/api exec wrangler login`, then try again.");
		}
		if (/no such table: vault_device_report/i.test(detail)) {
			return null;
		}
		throw new Error(`Could not query the server database: ${detail.trim().split("\n").slice(-3).join(" ")}`);
	}
	return JSON.parse(stdout)[0]?.results ?? [];
}

function parseArgs(argv) {
	const vaults = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--vault" && argv[i + 1]) {
			vaults.push(path.resolve(argv[i + 1]));
			i += 1;
		}
	}
	return { vaults };
}

/** Every Obsidian vault on this Mac that has Syncali installed. */
function discoverVaults() {
	const registry = path.join(homedir(), "Library/Application Support/obsidian/obsidian.json");
	if (!existsSync(registry)) {
		return [];
	}
	const vaults = Object.values(JSON.parse(readFileSync(registry, "utf8")).vaults ?? {});
	return vaults
		.map((vault) => vault.path)
		.filter((vaultPath) => existsSync(path.join(vaultPath, ".obsidian/plugins/syncali")));
}

function readLocalCopies(vaultPaths) {
	const byDevice = new Map();
	for (const vaultPath of vaultPaths) {
		const file = path.join(vaultPath, ".obsidian/plugins/syncali/device-reports.json");
		if (!existsSync(file)) {
			continue;
		}
		try {
			const snapshot = JSON.parse(readFileSync(file, "utf8"));
			for (const device of snapshot.devices ?? []) {
				const existing = byDevice.get(device.localVaultId);
				if (!existing || existing.fetchedAt < snapshot.fetchedAt) {
					byDevice.set(device.localVaultId, { ...device, fetchedAt: snapshot.fetchedAt, from: vaultPath });
				}
			}
		} catch {
			// A half-written copy is not worth failing the whole report over.
		}
	}
	return byDevice;
}

function count(n, noun, plural = `${noun}s`) {
	return `${Number(n).toLocaleString()} ${n === 1 ? noun : plural}`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const now = Date.now();
	const vaultPaths = args.vaults.length > 0 ? args.vaults : discoverVaults();
	const localCopies = readLocalCopies(vaultPaths);

	const vaults = queryD1(
		"SELECT v.id, v.name, s.current_cursor, s.entry_count, s.last_commit_at, s.last_flushed_at " +
			"FROM vault v LEFT JOIN vault_sync_status s ON s.vault_id = v.id ORDER BY v.name",
	);
	const rows = queryD1(
		"SELECT vault_id, local_vault_id, platform, plugin_version, report_json, reported_at " +
			"FROM vault_device_report ORDER BY reported_at DESC",
	);

	console.log(`Syncali sync doctor, ${formatDate(now)}`);
	if (rows === null) {
		console.log(
			"\nThe server does not keep device reports yet: its database has no vault_device_report table.\n" +
				"Deploy the current API (pnpm -C apps/api deploy:self-hosted), then update Syncali on each device.",
		);
		return;
	}

	for (const vault of vaults) {
		const reports = rows
			.filter((row) => row.vault_id === vault.id)
			.map((row) => ({ ...row, report: safeParse(row.report_json) }))
			.filter((row) => row.report);
		const latestServerCursor = Math.max(
			vault.current_cursor ?? 0,
			...reports.map((row) => row.report.serverCursor ?? 0),
		);

		console.log(`\nVault "${vault.name}"`);
		console.log(
			`  Server: ${count(vault.entry_count ?? 0, "entry", "entries")}, cursor ${Number(latestServerCursor).toLocaleString()}` +
				(vault.last_commit_at ? `, last change ${formatDate(vault.last_commit_at)}` : ""),
		);
		if (reports.length === 0) {
			console.log(
				"  No device has reported yet. A device reports while it runs Syncali 0.3.29 or later with this vault open.",
			);
			continue;
		}

		const newestVersion = reports.map((row) => row.plugin_version).sort(compareVersions).at(-1);
		const judged = reports.map((row) => {
			const verdict = assessDevice({
				report: row.report,
				reportedAt: row.reported_at,
				now,
				latestServerCursor,
			});
			return { row, verdict, label: describePlatform(row.report.platform, row.report.mobile) };
		});

		for (const { row, verdict, label } of judged) {
			const local = localCopies.get(row.local_vault_id);
			const marker = { stuck: "!!", needs_attention: "! ", catching_up: "~ ", quiet: "z ", up_to_date: "ok" }[verdict.state];
			console.log(`\n  [${marker}] ${label}${local?.isThisDevice ? " (this computer)" : ""}: ${verdict.headline}`);
			const facts = [
				`last report ${formatDuration(Math.max(0, now - row.reported_at))} ago`,
				`Syncali ${row.plugin_version}`,
				row.report.obsidianVersion ? `Obsidian ${row.report.obsidianVersion}` : null,
				`device ${row.local_vault_id.slice(0, 8)}`,
			].filter(Boolean);
			console.log(`       ${facts.join(" · ")}`);
			if (newestVersion && compareVersions(row.plugin_version, newestVersion) < 0) {
				console.log(`       Older Syncali than your other devices (${newestVersion}). Update it through BRAT.`);
			}
			for (const reason of verdict.reasons) {
				console.log(`       - ${reason}`);
			}
			printDetails(local, now);
		}

		for (const note of compareDeviceFiles(
			judged.map(({ row, verdict, label }) => ({ label, report: row.report, verdict })),
		)) {
			console.log(`\n  Note: ${note}`);
		}
	}
}

function printDetails(local, now) {
	if (!local) {
		console.log("       (No decrypted copy on this computer. Open Syncali settings > Devices here to fetch one.)");
		return;
	}
	if (now - local.fetchedAt > STALE_LOCAL_COPY_MS) {
		console.log(`       Decrypted details are ${formatDuration(now - local.fetchedAt)} old.`);
	}
	if (local.detailsError) {
		console.log(`       Details could not be decrypted: ${local.detailsError}`);
		return;
	}
	const details = local.details;
	if (!details) {
		return;
	}
	for (const problem of details.recentProblems.slice(0, 5)) {
		const when =
			problem.count > 1
				? `${count(problem.count, "time")} since ${formatDate(problem.firstAt)}`
				: formatDate(problem.at);
		console.log(`       Problem (${when}): ${problem.message}`);
	}
	for (const file of details.setAside.slice(0, 10)) {
		console.log(`       Not syncing: ${file.path} (${file.reason})`);
	}
	if (details.notYetSyncedTotal > 0) {
		console.log(`       Not in sync yet: ${count(details.notYetSyncedTotal, "file")}`);
		for (const file of details.notYetSynced.slice(0, 10)) {
			console.log(`         ${file.path} (${file.state.replaceAll("_", " ")})`);
		}
	}
}

function safeParse(json) {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function compareVersions(a = "", b = "") {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
