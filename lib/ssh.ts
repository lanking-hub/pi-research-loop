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
