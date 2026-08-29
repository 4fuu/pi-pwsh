import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SNAPSHOT_PATTERN = /^(\d{12})\.([0-9a-f]{32})\.json$/;
const WRITER_LOCK = ".writer-lock";
const LOCK_OWNER = "owner.json";
const LOCK_WAIT_MS = 5_000;
const OWNERLESS_LOCK_STALE_MS = 30_000;
const RETAINED_SNAPSHOTS = 3;

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
	throw lastError ?? errorWithCode("metadata snapshots disappeared while reading", "ENOENT");
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

async function lockIsStale(lockPath) {
	let lockStat;
	try {
		lockStat = await stat(lockPath);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	try {
		const owner = JSON.parse(await readFile(join(lockPath, LOCK_OWNER), "utf8"));
		return !isAlive(owner?.pid);
	} catch (error) {
		if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
		return Date.now() - lockStat.mtimeMs > OWNERLESS_LOCK_STALE_MS;
	}
}

async function acquireWriterLock(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, WRITER_LOCK);
	const token = randomUUID();
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			await mkdir(lockPath, { mode: 0o700 });
			try {
				await writeFile(join(lockPath, LOCK_OWNER), JSON.stringify({ pid: process.pid, token }), { encoding: "utf8", mode: 0o600 });
			} catch (error) {
				await rm(lockPath, { recursive: true, force: true });
				throw error;
			}
			return async () => {
				try {
					const owner = JSON.parse(await readFile(join(lockPath, LOCK_OWNER), "utf8"));
					if (owner?.token !== token) return;
					try {
						await rm(lockPath, { recursive: true, force: true });
					} catch {
						// If deletion is blocked, make the surviving lock immediately
						// reclaimable without exposing a pid:0 ABA window on the normal path.
						await writeFile(join(lockPath, LOCK_OWNER), JSON.stringify({ pid: 0, token }), { encoding: "utf8", mode: 0o600 });
					}
				} catch { /* A later writer can reclaim an ownerless or pid:0 lock. */ }
			};
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (await lockIsStale(lockPath)) {
				await rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline) throw errorWithCode("metadata snapshot writer lock is busy", "EBUSY");
			await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
		}
	}
}

async function pruneSnapshots(directory) {
	const snapshots = await listSnapshots(directory);
	const entries = await readdir(directory, { withFileTypes: true });
	const obsolete = [
		...snapshots.slice(RETAINED_SNAPSHOTS).map((snapshot) => snapshot.name),
		...entries.filter((entry) => entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp")).map((entry) => entry.name),
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
