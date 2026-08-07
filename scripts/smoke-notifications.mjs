import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobNotificationManager } from "../src/job-notifications.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-pwsh-notify-"));
const messages = [];
const widgets = [];
const pi = { sendMessage: (message, options) => messages.push({ message, options }) };
const ctx = { mode: "tui", hasUI: true, ui: { setWidget: (key, content, options) => widgets.push({ key, content, options }) } };
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
	assert.equal(widgets.at(-1)?.content, undefined);
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
	const runningWidget = widgets.at(-1);
	assert.equal(runningWidget.key, "pi-pwsh-jobs");
	assert.equal(typeof runningWidget.content, "function");
	assert.deepEqual(runningWidget.options, { placement: "belowEditor" });
	const widgetComponent = runningWidget.content({}, {
		bold: (text) => text,
		fg: (_tone, text) => text,
	});
	assert.deepEqual(widgetComponent.render(100).map((line) => line.trimEnd()), ["pwsh jobs · 1 running"]);
	const rpcWidgets = [];
	const rpcManager = new JobNotificationManager(pi, {
		mode: "rpc",
		hasUI: true,
		ui: { setWidget: (key, content, options) => rpcWidgets.push({ key, content, options }) },
	}, sessionId, {
		registryDir: directory,
		pollIntervalMs: 0,
		batchIntervalMs: 60_000,
	});
	await rpcManager.start();
	assert.deepEqual(rpcWidgets.at(-1), {
		key: "pi-pwsh-jobs",
		content: ["pwsh jobs · 1 running"],
		options: { placement: "belowEditor" },
	});
	await rpcManager.close();
	const widgetUpdates = widgets.length;
	await manager.scanNow();
	assert.equal(widgets.length, widgetUpdates);
	console.log("PASS [ready-steer-and-widget]");

	writeFileSync(join(directory, "server.exit"), "0");
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 2);
	assert.equal(messages[1].message.details.jobs[0].kind, "exit");
	assert.equal(messages[1].message.details.jobs[0].ok, true);
	assert.match(messages[1].message.details.jobs[0].output, /Listening on 4321/);
	assert.equal(messages[1].message.details.jobs[0].outputAlreadyReceived, undefined);
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

	const raced = metadata("raced", "9".repeat(32));
	writeFileSync(join(directory, "raced.log"), "raced output\n");
	writeFileSync(join(directory, "raced.exit"), "0");
	writeMeta(raced);
	await manager.scanNow();
	const originalMetadataState = manager.metadataState.bind(manager);
	let continueMetadata;
	const metadataMayContinue = new Promise((resolve) => { continueMetadata = resolve; });
	let metadataStarted;
	const metadataDidStart = new Promise((resolve) => { metadataStarted = resolve; });
	manager.metadataState = async (meta) => {
		metadataStarted();
		await metadataMayContinue;
		return originalMetadataState(meta);
	};
	const racedFlush = manager.flushNow();
	await metadataDidStart;
	const releaseRacedNotifications = manager.deferDuringPwshCall();
	continueMetadata();
	await racedFlush;
	assert.equal(messages.length, 5);
	manager.metadataState = originalMetadataState;
	releaseRacedNotifications();
	await manager.flushNow();
	assert.equal(messages.length, 6);
	assert.match(messages[5].message.details.jobs[0].output, /raced output/);
	console.log("PASS [foreground-call-starting-during-flush-defers-delivery]");

	const manual = metadata("manual", "f".repeat(32));
	writeFileSync(join(directory, "manual.log"), "large final output that should not be repeated\n");
	writeFileSync(join(directory, "manual.exit"), "0");
	writeMeta(manual);
	const releaseNotifications = manager.deferDuringPwshCall();
	await manager.scanNow();
	await manager.flushNow();
	assert.equal(messages.length, 6);
	writeFileSync(join(directory, `${manual.InstanceId}.exit.presented`), "");
	releaseNotifications();
	await manager.flushNow();
	assert.equal(messages.length, 7);
	assert.equal(messages[6].message.details.jobs[0].outputAlreadyReceived, true);
	assert.equal(messages[6].message.details.jobs[0].output, "");
	assert.doesNotMatch(messages[6].message.content, /large final output/);
	assert.match(messages[6].message.content, /already returned by Receive-Job/);
	console.log("PASS [manual-read-defers-and-reduces-completion]");

	await manager.close();
	assert.equal(widgets.at(-1)?.content, undefined);
	console.log("PASS [shutdown-clears-widget]");
	const resumed = new JobNotificationManager(pi, ctx, sessionId, {
		registryDir: directory,
		pollIntervalMs: 0,
		batchIntervalMs: 60_000,
	});
	await resumed.start();
	await resumed.flushNow();
	assert.equal(messages.length, 7);
	await resumed.close();
	console.log("PASS [reload-does-not-duplicate-notifications]");
	console.log("\n=== 10 passed, 0 failed ===");
} finally {
	await manager.close();
	rmSync(directory, { recursive: true, force: true });
}
