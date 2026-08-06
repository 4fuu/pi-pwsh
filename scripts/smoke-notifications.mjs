import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobNotificationManager } from "../src/job-notifications.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-pwsh-notify-"));
const messages = [];
const statuses = [];
const pi = { sendMessage: (message, options) => messages.push({ message, options }) };
const ctx = { hasUI: true, ui: { setStatus: (_key, value) => statuses.push(value) } };
const sessionId = "session-a";
const manager = new JobNotificationManager(pi, ctx, sessionId, {
	registryDir: directory,
	pollIntervalMs: 0,
	batchIntervalMs: 60_000,
});

function metadata(name, instanceId, owner = sessionId) {
	return {
		Id: 1,
		Name: name,
		InstanceId: instanceId,
		SessionId: owner,
		Pid: process.pid,
		Command: "example server",
		StartedAt: new Date(Date.now() - 1_000).toISOString(),
		NotifyOnExit: true,
		NotifyOn: "Listening on",
	};
}

function writeMeta(value) {
	writeFileSync(join(directory, `${value.Name}.meta.json`), JSON.stringify(value));
}

try {
	writeMeta(metadata("foreign", "1".repeat(32), "session-b"));
	await manager.start();
	await manager.flushNow();
	assert.equal(messages.length, 0);
	assert.equal(statuses.at(-1), undefined);
	console.log("PASS [session-isolation]");

	rmSync(join(directory, "foreign.meta.json"));
	const first = metadata("server", "a".repeat(32));
	writeFileSync(join(directory, "server.log"), "booting\nListening on 4321\n");
	writeMeta(first);
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 1);
	assert.equal(messages[0].message.details.jobs[0].kind, "ready");
	assert.deepEqual(messages[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.match(statuses.at(-1), /1 pwsh job running/);
	console.log("PASS [ready-steer-and-status]");

	writeFileSync(join(directory, "server.exit"), "0");
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 2);
	assert.equal(messages[1].message.details.jobs[0].kind, "exit");
	assert.equal(messages[1].message.details.jobs[0].ok, true);
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 2);
	console.log("PASS [completion-once]");

	const second = metadata("server", "b".repeat(32));
	writeFileSync(join(directory, "server.log"), "Listening on new instance\n");
	rmSync(join(directory, "server.exit"));
	writeMeta(second);
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 3);
	assert.equal(messages[2].message.details.jobs[0].kind, "ready");
	console.log("PASS [same-name-new-instance]");

	const stale = metadata("aaa", "c".repeat(32));
	const deliverable = metadata("zzz", "d".repeat(32));
	writeFileSync(join(directory, "aaa.log"), "Listening on stale\n");
	writeFileSync(join(directory, "zzz.log"), "Listening on deliverable\n");
	writeMeta(stale);
	writeMeta(deliverable);
	await manager.scanNow();
	manager.pending.sort((left, right) => left.meta.name.localeCompare(right.meta.name));
	writeMeta(metadata("aaa", "e".repeat(32)));
	await manager.flushNow();
	assert.equal(messages.length, 4);
	assert.deepEqual(messages[3].message.details.jobs.map((job) => job.name), ["zzz"]);
	console.log("PASS [stale-event-does-not-drop-batch]");
	rmSync(join(directory, "aaa.meta.json"));
	rmSync(join(directory, "aaa.log"));

	writeFileSync(join(directory, "zzz.exit"), "");
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 4);
	writeFileSync(join(directory, "zzz.exit"), "7");
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 5);
	assert.equal(messages[4].message.details.jobs[0].ok, false);
	console.log("PASS [partial-exit-file-is-not-success]");

	await manager.close();
	assert.equal(statuses.at(-1), undefined);
	console.log("PASS [shutdown-clears-status]");
	const resumed = new JobNotificationManager(pi, ctx, sessionId, {
		registryDir: directory,
		pollIntervalMs: 0,
		batchIntervalMs: 60_000,
	});
	await resumed.start();
	await resumed.flushNow();
	assert.equal(messages.length, 5);
	await resumed.close();
	console.log("PASS [reload-does-not-duplicate-notifications]");
	console.log("\n=== 8 passed, 0 failed ===");
} finally {
	await manager.close();
	rmSync(directory, { recursive: true, force: true });
}
