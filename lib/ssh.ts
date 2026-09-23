import { execFile } from "node:child_process";

export interface SshResult {
	ok: boolean;
	out: string;
	err: string;
}

export function sshBin(): string {
	return process.platform === "win32" ? "ssh.exe" : "ssh";
}

/**
 * 本地模式的标记值：pi 就装在跑实验的那台机器上，不需要 ssh。
 * 在配置里写 `"sshHost": "local"` 启用。
 */
export const LOCAL_HOST = "local";

export function isLocal(host: string | undefined): boolean {
	return !host || host === LOCAL_HOST;
}

/** 在本机执行一条命令（本地模式用） */
export function runLocal(cmd: string, timeoutSec = 15): Promise<SshResult> {
	return new Promise((resolve) => {
		execFile(
			process.platform === "win32" ? "cmd.exe" : "/bin/sh",
			[process.platform === "win32" ? "/c" : "-c", cmd],
			{ timeout: (timeoutSec + 15) * 1000, windowsHide: true },
			(error, stdout, stderr) => {
				resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "") });
			},
		);
	});
}

/**
 * 统一入口：根据 host 决定走 ssh 还是本地执行。
 * 整个项目只有这一个地方需要区分，其他代码一律调它。
 */
export function runRemote(
	host: string | undefined,
	cmd: string,
	timeoutSec = 15,
): Promise<SshResult> {
	if (isLocal(host)) return runLocal(cmd, timeoutSec);
	return runSsh(host as string, cmd, timeoutSec);
}

/**
 * 在远程服务器上执行一条命令。
 *
 * 用 execFile + 参数数组，不走本地 shell，避免 Windows cmd 的引号问题。
 * 所以 remoteCmd 里可以自由带空格和单引号（远端是 Linux，单引号由远端 shell 解释）。
 */
export function runSsh(host: string, remoteCmd: string, timeoutSec = 15): Promise<SshResult> {
	return new Promise((resolve) => {
		execFile(
			sshBin(),
			["-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeoutSec}`, host, remoteCmd],
			{ timeout: (timeoutSec + 15) * 1000, windowsHide: true },
			(error, stdout, stderr) => {
				resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "") });
			},
		);
	});
}
