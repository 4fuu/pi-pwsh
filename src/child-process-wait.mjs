const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for the direct child to exit, then drain its pipes until both end or no
 * output arrives for a short grace period. A detached descendant may inherit
 * the pipe handles, so waiting only for `close` can hang indefinitely.
 */
export function waitForChildProcess(child) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode = null;
		let signal = null;
		let postExitTimer;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = () => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({ exitCode, signal });
		};

		const maybeFinalizeAfterExit = () => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code, exitSignal) => {
			exited = true;
			exitCode = code;
			signal = exitSignal;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code, closeSignal) => {
			exitCode = code;
			signal = closeSignal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
