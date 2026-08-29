import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SNAPSHOT_PATTERN = /^(\d{12})\.([0-9a-f]{32})\.json$/;
const WRITER_CHOOSING_PATTERN = /^\.writer-choosing\.(\d+)\.([0-9a-f]{32})$/;
const WRITER_TICKET_PATTERN = /^\.writer-ticket\.(\d{12})\.(\d+)\.([0-9a-f]{32})$/;
const LOCK_WAIT_MS = 5_000;
const RETAINED_SNAPSHOTS = 3;
const SNAPSHOT_RELIST_ATTEMPTS = 3;
const SNAPSHOT_RELIST_DELAY_MS = 5;

function errorWithCode(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function snapshotEntry(entry) {
	if (!entry.isFile()) return undefined;
	const match = SNAPSHOT_PATTERN.exec(entry.name);
	if (!match) return undefined;
	return { name: entry.name, revision: Number(match[1]) };
}

async function listSnapshots(directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") throw errorWithCode("metadata snapshot store does not exist", "ENOENT");
		throw error;
	}
	return entries
		.map(snapshotEntry)
		.filter((entry) => entry !== undefined)
		.sort((a, b) => b.revision - a.revision || b.name.localeCompare(a.name));
}

export async function readLatestMetadataSnapshot(directory, validate = (value) => value) {
	for (let attempt = 0; attempt < SNAPSHOT_RELIST_ATTEMPTS; attempt++) {
		const snapshots = await listSnapshots(directory);
		if (snapshots.length === 0) throw errorWithCode("metadata snapshot store is empty", "ENOENT");
		let lastError;
		for (const snapshot of snapshots) {
			let raw;
			try {
				raw = await readFile(join(directory, snapshot.name), "utf8");
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
			try {
				const envelope = JSON.parse(raw);
				if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("invalid metadata snapshot");
				if (envelope.storageVersion !== 2 || envelope.revision !== snapshot.revision) throw new Error("invalid metadata snapshot revision");
				return {
					revision: snapshot.revision,
					metadata: validate(envelope.metadata),
					path: join(directory, snapshot.name),
				};
			} catch (error) {
				lastError = error;
			}
		}
		// Relist only when every enumerated path vanished before it could be
		// opened. Persistent JSON/schema corruption must not become a retry loop.
		if (lastError) throw lastError;
		if (attempt + 1 < SNAPSHOT_RELIST_ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RELIST_DELAY_MS));
		}
	}
	throw errorWithCode("metadata snapshots disappeared while reading", "ENOENT");
}

/** Rename with bounded retries for transient Windows sharing violations. */
export async function renameWithRetry(from, to) {
	let lastError;
	const attempts = 8;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
			lastError = error;
			if (attempt + 1 < attempts) {
				await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 1_600)));
			}
		}
	}
	throw lastError;
}

function writerClaim(entry) {
	if (!entry.isFile()) return undefined;
	let match = WRITER_CHOOSING_PATTERN.exec(entry.name);
	if (match) return { name: entry.name, choosing: true, pid: Number(match[1]), token: match[2] };
	match = WRITER_TICKET_PATTERN.exec(entry.name);
	if (!match) return undefined;
	return { name: entry.name, choosing: false, ticket: Number(match[1]), pid: Number(match[2]), token: match[3] };
}

async function listWriterClaims(directory) {
	const claims = (await readdir(directory, { withFileTypes: true }))
		.map(writerClaim)
		.filter((claim) => claim !== undefined);
	const active = [];
	for (const claim of claims) {
		if (isAlive(claim.pid)) {
			active.push(claim);
			continue;
		}
		// Claim names contain a random owner token and are never reused. Removing
		// this exact dead process's claim cannot delete a replacement owner.
		await rm(join(directory, claim.name), { force: true }).catch(() => {});
	}
	return active;
}

async function retireWriterClaim(path) {
	try {
		await rm(path, { force: true });
	} catch {
		// A renamed claim no longer matches the active-claim grammar. This keeps
		// publication committed if antivirus briefly prevents deletion on Windows.
		try {
			await rename(path, `${path}.released.${randomUUID()}`);
		} catch { /* A later cleanup can remove an abandoned, uniquely owned claim. */ }
	}
}

// Filesystem form of Lamport's bakery lock. A choosing claim closes the race
// while a process selects a ticket; ticket/token order then admits one writer.
// Every reclaim targets an immutable owner path rather than a shared lock name.
async function acquireWriterLock(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const token = randomUUID().replaceAll("-", "");
	const choosingPath = join(directory, `.writer-choosing.${process.pid}.${token}`);
	let ticketName, ticketPath;
	try {
		await writeFile(choosingPath, "", { mode: 0o600, flag: "wx" });
		try {
			const claims = await listWriterClaims(directory);
			const ticket = Math.max(-1, ...claims.filter((claim) => !claim.choosing).map((claim) => claim.ticket)) + 1;
			if (!Number.isSafeInteger(ticket) || ticket > 999_999_999_999) throw new Error("metadata writer ticket is exhausted");
			ticketName = `.writer-ticket.${String(ticket).padStart(12, "0")}.${process.pid}.${token}`;
			ticketPath = join(directory, ticketName);
			await writeFile(ticketPath, "", { mode: 0o600, flag: "wx" });
		} finally {
			await retireWriterClaim(choosingPath);
		}

		const deadline = Date.now() + LOCK_WAIT_MS;
		while (true) {
			const claims = await listWriterClaims(directory);
			if (!claims.some((claim) => claim.name === ticketName)) {
				throw errorWithCode("metadata snapshot writer lost its ticket", "EBUSY");
			}
			const choosing = claims.some((claim) => claim.choosing);
			const tickets = claims.filter((claim) => !claim.choosing)
				.sort((a, b) => a.ticket - b.ticket || a.token.localeCompare(b.token));
			if (!choosing && tickets[0]?.name === ticketName) {
				return () => retireWriterClaim(ticketPath);
			}
			if (Date.now() >= deadline) throw errorWithCode("metadata snapshot writer lock is busy", "EBUSY");
			await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
		}
	} catch (error) {
		if (ticketPath) await retireWriterClaim(ticketPath);
		throw error;
	}
}

async function pruneSnapshots(directory) {
	const snapshots = await listSnapshots(directory);
	const entries = await readdir(directory, { withFileTypes: true });
	const obsolete = [
		...snapshots.slice(RETAINED_SNAPSHOTS).map((snapshot) => snapshot.name),
		...entries.filter((entry) => entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp")).map((entry) => entry.name),
		...entries.filter((entry) => entry.isFile() && entry.name.includes(".released.")
			&& (entry.name.startsWith(".writer-choosing.") || entry.name.startsWith(".writer-ticket."))).map((entry) => entry.name),
	];
	await Promise.allSettled(obsolete.map((name) => rm(join(directory, name), { force: true })));
}

export async function mutateMetadataSnapshots(directory, mutate, options = {}) {
	const release = await acquireWriterLock(directory);
	let temporary;
	try {
		let current;
		try {
			current = await readLatestMetadataSnapshot(directory, options.validate);
		} catch (error) {
			if (error?.code !== "ENOENT" || !options.allowCreate) throw error;
		}
		const candidate = await mutate(current?.metadata);
		if (candidate === undefined) {
			if (!current) throw new Error("metadata mutation did not create an initial snapshot");
			return current;
		}
		const metadata = options.validate ? options.validate(candidate) : candidate;
		// Advance past every published filename, including a corrupt newest
		// snapshot that readLatestMetadataSnapshot deliberately fell back around.
		const published = await listSnapshots(directory);
		const revision = (published[0]?.revision ?? -1) + 1;
		if (!Number.isSafeInteger(revision) || revision > 999_999_999_999) throw new Error("metadata snapshot revision is exhausted");
		const name = `${String(revision).padStart(12, "0")}.${randomUUID().replaceAll("-", "")}.json`;
		temporary = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify({ storageVersion: 2, revision, metadata }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await options.beforePublish?.();
		const path = join(directory, name);
		await renameWithRetry(temporary, path);
		temporary = undefined;
		// Publication is already durable. Cleanup is best-effort so it cannot
		// turn a committed state transition into a reported task failure.
		await pruneSnapshots(directory).catch(() => {});
		return { revision, metadata, path };
	} finally {
		if (temporary) await rm(temporary, { force: true });
		await release();
	}
}
