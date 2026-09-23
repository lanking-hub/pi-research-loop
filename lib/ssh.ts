import { execFile } from "node:child_process";

export interface SshResult {
	ok: boolean;
	out: string;
	err: string;
}

export function sshBin(): string {
	return process.platform === "win32" ? "ssh.exe" : "ssh";
}

/** 取远程服务器上该用户的 home 目录 */
export async function remoteHome(host: string, timeoutSec = 15): Promise<string | undefined> {
	const res = await runSsh(host, "echo $HOME", timeoutSec);
	const home = res.out.trim();
	return home ? home : undefined;
}

/**
 * 把 "~/xxx" 展开成绝对路径。
 *
 * 必须自己展开：shell 只对**未加引号**的 ~ 做展开，而我们为了防止路径里有空格
 * 会把路径加引号传过去（test -d "..."、mkdir -p "..."），此时 ~ 不会被展开，
 * 会真的去操作一个名叫 "~" 的目录。
 */
export function expandRemotePath(p: string, home: string | undefined): string {
	if (!home) return p;
	const base = home.replace(/\/+$/, "");
	if (p === "~") return base;
	if (p.startsWith("~/")) return `${base}/${p.slice(2)}`;
	return p;
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
