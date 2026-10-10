// Encoding contract for the non-interactive path (real pwsh):
// - the task log stores UTF-8 for PowerShell, node, and cmd, with no VT
// - a console exe inherits code page 65001 while stdout stays redirected
// - cmd /c exit 3 still surfaces as process exit 3 with no user text
// - the Win32 batch retry inherits that page; chcp on a redirected cmd does not
// Run: npx tsx scripts/smoke-encoding.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userPowerShellArguments } from "../src/runtime.ts";
import { SOURCE_BOOTSTRAP, spawnAndStream, UTF8_PREFIX, WINDOWS_CONSOLE_PAGE_CHECK, wrapPowerShellCommand } from "../src/spawn.ts";
import { PwshTaskRuntime } from "../src/task-runtime.ts";

const HELLO = "\u041F\u0440\u0438\u0432\u0435\u0442";
const EMOJI = "\u{1F600}";
const MARK = `${HELLO} ${EMOJI}`;
const MARK_BYTES = Buffer.from(MARK, "utf8");
const OEM866_HELLO = Buffer.from("8fe0a8a2a5e2", "hex");

// The console code page and cmd.exe contracts are Windows-only.
if (process.platform !== "win32") {
	console.log("SKIP [encoding e2e] non-win32 platform: the console page and cmd /c contracts are Windows-only");
	process.exit(0);
}

const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "(Get-Command pwsh -ErrorAction Stop).Source"], {
	encoding: "utf8",
	windowsHide: true,
});
if (probe.error?.code === "ENOENT" || probe.status !== 0 || !probe.stdout.trim()) {
	console.log("SKIP [encoding e2e] pwsh is not installed");
	process.exit(0);
}

const executable = probe.stdout.trim();
const pwsh = {
	executable,
	loadProfile: false,
	executionPolicy: "Bypass",
	stopOnError: false,
	pythonUtf8: true,
	pythonUnbuffered: true,
};
const pwshArgs = [...userPowerShellArguments(pwsh, { nonInteractive: true }), "-Command", SOURCE_BOOTSTRAP];

function countOf(haystack, needle) {
	let count = 0;
	let from = 0;
	while (from <= haystack.length - needle.length) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) break;
		count++;
		from = at + needle.length;
	}
	return count;
}

function hexPreview(buffer) {
	return buffer.subarray(0, 240).toString("hex");
}

async function streamSource(source, cwd) {
	const chunks = [];
	const result = await spawnAndStream(executable, pwshArgs, cwd, {
		onData: (data) => chunks.push(data),
		stdin: Buffer.from(source, "utf8").toString("base64"),
	});
	return { ...result, output: Buffer.concat(chunks) };
}

function oemCodePage() {
	if (process.platform !== "win32") return 65001;
	const script = [
		"Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class PiPwshOem { [DllImport(\"kernel32.dll\")] public static extern uint GetOEMCP(); }'",
		"[PiPwshOem]::GetOEMCP()",
	].join("; ");
	const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(result.status, 0, `GetOEMCP failed: ${result.stderr}`);
	return Number(result.stdout.trim());
}

function dotnetList(args) {
	const result = spawnSync("dotnet", args, { encoding: "utf8", windowsHide: true });
	if (result.error?.code === "ENOENT" || result.status !== 0) return "";
	return result.stdout ?? "";
}

function versionList(text, pattern) {
	const versions = [];
	for (const line of text.split(/\r?\n/)) {
		const match = pattern.exec(line);
		if (match) versions.push([Number(match[1]), Number(match[2])]);
	}
	versions.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	return versions;
}

function selectTfm(runtimes, sdks) {
	const runtimeVersions = versionList(runtimes, /^Microsoft\.NETCore\.App (\d+)\.(\d+)\./);
	const sdkVersions = versionList(sdks, /^(\d+)\.(\d+)\./);
	if (runtimeVersions.length === 0 || sdkVersions.length === 0) return null;
	const [sdkMajor, sdkMinor] = sdkVersions[sdkVersions.length - 1];
	const usable = runtimeVersions.filter(([major, minor]) => major < sdkMajor || (major === sdkMajor && minor <= sdkMinor));
	if (usable.length === 0) return null;
	const [major, minor] = usable[usable.length - 1];
	return `net${major}.${minor}`;
}

async function buildProbe(dir, tfm) {
	await mkdir(dir, { recursive: true });
	const project = join(dir, "probe.csproj");
	await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${tfm}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <InvariantGlobalization>true</InvariantGlobalization>
    <DebugType>none</DebugType>
    <DebugSymbols>false</DebugSymbols>
  </PropertyGroup>
</Project>
`);
	await writeFile(join(dir, "Program.cs"), `Console.Write("cp=");
Console.Write(Console.OutputEncoding.CodePage.ToString(System.Globalization.CultureInfo.InvariantCulture));
Console.Write(" redirected=");
Console.WriteLine(Console.IsOutputRedirected);
Console.WriteLine("\\u041F\\u0440\\u0438\\u0432\\u0435\\u0442 \\U0001F600");
`);
	const build = spawnSync("dotnet", ["build", project, "-c", "Release", "--nologo", "-v", "q"], {
		cwd: dir,
		encoding: "utf8",
		windowsHide: true,
	});
	const exe = join(dir, "bin", "Release", tfm, "probe.exe");
	if (build.status !== 0 || !existsSync(exe)) {
		console.log(`SKIP [encoding e2e] console exe: dotnet build for ${tfm} failed`);
		const detail = `${build.stdout ?? ""}\n${build.stderr ?? ""}`.trim();
		if (detail) console.log(detail);
		return null;
	}
	return exe;
}

function psQuote(value) {
	return `'${value.replaceAll("'", "''")}'`;
}

const root = await mkdtemp(join(tmpdir(), "pi-pwsh-encoding-test-"));
try {
	const tfm = selectTfm(dotnetList(["--list-runtimes"]), dotnetList(["--list-sdks"]));
	const exe = tfm === null ? null : await buildProbe(join(root, "probe"), tfm);
	const taskDir = join(root, "tasks");
	const runtime = new PwshTaskRuntime(pwsh, { taskDir, sessionId: "encoding-test" });
	const lines = [
		`Write-Output 'PS ${MARK}'`,
		`node -e "process.stdout.write('NODE ${MARK}\\n')"`,
		`cmd /d /c "echo CMD ${MARK}"`,
	];
	if (exe) lines.push(`& ${psQuote(exe)}`);
	lines.push("Write-Progress -Activity 'x' -PercentComplete 10", "Write-Output 'AFTER'");
	const started = await runtime.start(lines.join("\n"), root);
	const done = await runtime.snapshot(started.id, 40);
	assert.equal(done.metadata.status, "completed", `unexpected status: ${done.metadata.error ?? done.metadata.status}\n${done.output}`);
	const log = await readFile(join(runtime.taskDirectoryPath(started.id), "output.log"));
	const marks = countOf(log, MARK_BYTES);
	assert.ok(marks >= 3, `expected UTF-8 ${MARK} at least 3 times, found ${marks}; hex ${hexPreview(log)}`);
	assert.equal(log.includes(0x1b), false, `VT byte in task log: ${hexPreview(log)}`);
	assert.ok(log.includes(Buffer.from("AFTER")), "AFTER missing from task log");
	if (exe) {
		assert.ok(marks >= 4, `probe exe did not add a fourth UTF-8 ${MARK}; hex ${hexPreview(log)}`);
		assert.ok(log.includes(Buffer.from("cp=65001")), `cp=65001 missing:\n${log.toString("utf8")}`);
		assert.ok(log.includes(Buffer.from("redirected=True")), `redirected=True missing:\n${log.toString("utf8")}`);
	} else if (tfm === null) {
		console.log("SKIP [encoding e2e] console exe: no SDK and runtime that can be compiled together");
	}
	console.log("PASS [encoding e2e] task log is UTF-8 without VT");

	const exit = await streamSource(
		`${UTF8_PREFIX}$global:LASTEXITCODE = $null; ${wrapPowerShellCommand("cmd /c exit 3")}`,
		root,
	);
	assert.equal(exit.exitCode, 3, `expected exit 3, got ${exit.exitCode}; hex ${hexPreview(exit.output)}`);
	assert.equal(exit.output.toString("utf8").trim(), "", `expected empty user stdout, got ${JSON.stringify(exit.output.toString("utf8"))}`);
	console.log("PASS [encoding e2e] native exit 3 keeps an empty user stdout");

	if (process.platform === "win32") {
		const oem = oemCodePage();
		const forcedPage = oem === 65001 ? 437 : oem;
		// The managed property stays 65001 after this assignment. The OS page
		// is then moved off 65001, which is the case the property cannot see.
		const disagree = await streamSource(
			"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
				`$__pipwsh_set = [System.Console].Assembly.GetType('Interop+Kernel32').GetMethod('SetConsoleOutputCP',[Reflection.BindingFlags]'Public,NonPublic,Static').Invoke($null,@(${forcedPage})); ` +
				"if (-not $__pipwsh_set) { throw 'SetConsoleOutputCP failed' }; " +
				WINDOWS_CONSOLE_PAGE_CHECK +
				"Write-Output ('property=' + [Console]::OutputEncoding.CodePage); " +
				"Write-Output 'USER-RAN'",
			root,
		);
		const disagreeText = disagree.output.toString("utf8");
		assert.equal(disagree.exitCode, 0, `page check changed the exit code: ${disagreeText}`);
		assert.ok(
			disagreeText.includes(`[pi-pwsh] console output code page is ${forcedPage}, not 65001`),
			`live page warning missing:\n${disagreeText}`,
		);
		assert.ok(disagreeText.includes("property=65001"), `managed page was not left at 65001:\n${disagreeText}`);
		assert.ok(disagreeText.includes("USER-RAN"), `user command did not run after the warning:\n${disagreeText}`);
		console.log("PASS [encoding e2e] cached OutputEncoding does not hide a non-UTF-8 console page");

		const direct = spawnSync("cmd.exe", ["/d", "/s", "/c", `chcp 65001>nul & echo ${HELLO}`], { windowsHide: true });
		assert.equal(direct.status, 0, `direct cmd echo failed: ${direct.status}`);
		const encodedCommand = Buffer.from(`echo ${HELLO}`, "utf8").toString("base64");
		const retry = await streamSource(
			`${UTF8_PREFIX}$global:LASTEXITCODE = $null; ` +
				wrapPowerShellCommand(
					`& 'cmd.exe' '/d' '/s' '/c' ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedCommand}')))`,
				),
			root,
		);
		assert.equal(retry.exitCode, 0, `retry shape exit ${retry.exitCode}; hex ${hexPreview(retry.output)}`);
		if (oem === 65001) {
			console.log("SKIP [encoding e2e] OEM is already 65001; byte contrast not checked");
		} else {
			const hello = Buffer.from(HELLO, "utf8");
			assert.equal(direct.stdout.includes(hello), false, `chcp changed redirected cmd bytes: ${hexPreview(direct.stdout)}`);
			if (oem === 866) assert.ok(direct.stdout.includes(OEM866_HELLO), `expected OEM 866 bytes, got ${hexPreview(direct.stdout)}`);
			assert.ok(retry.output.includes(hello), `prefixed cmd child is not UTF-8: ${hexPreview(retry.output)}`);
		}
		console.log("PASS [encoding e2e] batch retry inherits UTF-8; redirected chcp does not");

		// The retry passes the whole user command as one /c string. A batch file
		// in a quoted path with quoted arguments must still be found, receive its
		// arguments, and keep its exit code (cmd keeps %2 in raw quoted form).
		const batchDir = join(root, "dir with space");
		await mkdir(batchDir, { recursive: true });
		const batchPath = join(batchDir, "my tool.bat");
		await writeFile(batchPath, '@echo off\r\necho BAT-RAN %1 %2\r\nexit /b 7\r\n', "ascii");
		const batchCommand = `"${batchPath}" one "two three"`;
		const encodedBatch = Buffer.from(batchCommand, "utf8").toString("base64");
		const batchRetry = await streamSource(
			`${UTF8_PREFIX}$global:LASTEXITCODE = $null; ` +
				wrapPowerShellCommand(
					`& 'cmd.exe' '/d' '/s' '/c' ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedBatch}')))`,
				),
			root,
		);
		assert.equal(batchRetry.exitCode, 7, `batch retry exit ${batchRetry.exitCode}: ${batchRetry.output}`);
		assert.ok(
			batchRetry.output.includes('BAT-RAN one "two three"'),
			`batch retry lost the quoted path or arguments: ${batchRetry.output}`,
		);
		console.log("PASS [encoding e2e] batch retry preserves a quoted path and arguments");
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
