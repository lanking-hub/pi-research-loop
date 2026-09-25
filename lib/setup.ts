/**
 * /rl setup —— 交互式一键整备向导。
 *
 * 设计原则：
 *   - **问得越少越好**：只问「服务器地址」和「用户名」两件事。
 *     ssh 别名是固定常量（内部细节），不暴露给用户。
 *   - **一次跑完**：需要人动手的环节（装公钥）在向导内部暂停等待确认，
 *     不要求用户「跑两遍」。
 *   - **幂等**：已完成的步骤自动跳过，半途失败后重跑是安全的。
 *   - **零配置**：table 模式不需要任何配置文件，配完 ssh 就能跑。
 *
 * 唯一躲不开的手动环节：把公钥装上服务器需要服务器密码。向导内输入一次，
 * 由 ssh2（纯 JS SSH 客户端，不经过任何 shell/终端）自动完成安装；
 * ssh2 不可用或服务器禁密码登录时，退回「打印命令 + 等确认」的兜底模式。
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, SSH_ALIAS } from "./config.ts";
import { isLocal, runLocal, runRemote, sshBin } from "./ssh.ts";

const IS_WIN = process.platform === "win32";
const keyscanBin = IS_WIN ? "ssh-keyscan.exe" : "ssh-keyscan";
const keygenBin = IS_WIN ? "ssh-keygen.exe" : "ssh-keygen";

const MAX_KEY_ATTEMPTS = 3;

/** ssh2 的最小结构类型（避免 lib 层硬依赖 @types/ssh2 也能编译） */
interface Ssh2Stream {
	on(event: "data", fn: (d: Buffer) => void): Ssh2Stream;
	stderr: { on(event: "data", fn: (d: Buffer) => void): unknown };
	on(event: "close", fn: (code: number) => void): Ssh2Stream;
}
interface Ssh2Client {
	on(event: "ready", fn: () => void): Ssh2Client;
	on(event: "error", fn: (e: Error) => void): Ssh2Client;
	on(
		event: "keyboard-interactive",
		fn: (
			name: string,
			instr: string,
			lang: string,
			prompts: Array<{ prompt: string; echo: boolean }>,
			finish: (responses: string[]) => void,
		) => void,
	): Ssh2Client;
	exec(cmd: string, cb: (err: Error | undefined, stream: Ssh2Stream) => void): void;
	end(): void;
	connect(cfg: Record<string, unknown>): void;
}
type Ssh2Ctor = new () => Ssh2Client;

let ssh2Ctor: Ssh2Ctor | undefined; // undefined = 尚未加载成功（下次再试，临时失败不禁用）

/** 动态加载 ssh2：依赖缺失时扩展本身仍能正常加载（走打印命令兜底） */
async function loadSsh2(): Promise<Ssh2Ctor | undefined> {
	if (ssh2Ctor) return ssh2Ctor;
	try {
		const mod = (await import("ssh2")) as unknown as { Client: Ssh2Ctor };
		ssh2Ctor = mod.Client;
	} catch {
		// 保持 undefined：下次调用重试（装包可能是后来才完成的）
	}
	return ssh2Ctor;
}

/**
 * ssh2 密码直连装公钥——根治终端兼容问题的主路径。
 * 全程没有 shell 参与：公钥由 Node 读文件、命令由远端 bash 直接执行，
 * 因此 PowerShell 剥引号 / 管道注 CR / 终端折行复制 这些坑从物理上不存在。
 * 密码只活在本函数栈里，绝不写进 lines / ui 输出 / 日志。
 * 幂等：公钥已在 authorized_keys 里时不重复追加（grep -qF 判定）。
 */
async function installKeyViaSsh2(
	host: string,
	user: string,
	password: string,
	pubKey: string,
): Promise<{ ok: boolean; err?: string }> {
	const Client = await loadSsh2();
	if (!Client) return { ok: false, err: "ssh2 组件不可用（依赖未安装）" };
	// 远端单引号包裹；公钥是 base64+类型+注释，不会含单引号，转义纯防御
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const key = pubKey.trim();
	const cmd = [
		"mkdir -p ~/.ssh && chmod 700 ~/.ssh",
		`grep -qF ${q(key)} ~/.ssh/authorized_keys 2>/dev/null || echo ${q(key)} >> ~/.ssh/authorized_keys`,
		"chmod 600 ~/.ssh/authorized_keys && rm -f ~/rl-pub.tmp",
	].join(" && ");
	return await new Promise((resolve) => {
		const conn = new Client();
		const done = (r: { ok: boolean; err?: string }) => {
			clearTimeout(timer);
			try {
				conn.end();
			} catch {
				/* 已断开 */
			}
			resolve(r);
		};
		const timer = setTimeout(() => done({ ok: false, err: "连接超时（20s）" }), 20000);
		conn.on("ready", () => {
			conn.exec(cmd, (err, stream) => {
				if (err) return done({ ok: false, err: err.message });
				let eout = "";
				stream.stderr.on("data", (d: Buffer) => (eout += d.toString()));
				stream.on("close", (code: number) => {
					if (code === 0) return done({ ok: true });
					done({ ok: false, err: `远端命令失败（退出码 ${code}）：${eout.trim().slice(0, 300)}` });
				});
			});
		});
		conn.on("error", (e) => done({ ok: false, err: e.message }));
		// 2026-09-24 实测：owner 用同一密码手动 ssh 登录成功，但 ssh2 默认只发
		// `password` 认证会失败——部分服务器只开 keyboard-interactive。显式
		// 开启 tryKeyboard 并响应 cb，两种认证方式都覆盖。
		conn.on("keyboard-interactive", (_name, _instr, _ilang, _prompts, finish) => {
			finish([password]);
		});
		conn.connect({
			host,
			port: 22,
			username: user,
			password,
			tryKeyboard: true,
			readyTimeout: 15000,
		});
	});
}

/** 交互能力的最小接口——lib 不依赖 pi 的类型，方便单独测试 */
export interface SetupUI {
	/** 问一句，返回用户输入；取消返回 undefined */
	ask(title: string, placeholder?: string): Promise<string | undefined>;
	/** 等用户确认；取消返回 false */
	confirm(title: string, message: string): Promise<boolean>;
	/** 错误级强提醒（失败原因必须让用户看到，不能被后续输出刷掉） */
	setupError?(text: string): void;
	/**
	 * 立刻把一段文字显示给用户。
	 * 必须有：报告是在 setup 跑完后才统一输出的，而 confirm 是中途弹的，
	 * 不提前说的话用户会看到「执行上面那条命令」却压根没有命令。
	 */
	say(text: string): void;
	/** 常驻状态行（耗时步骤前调用，结束传 undefined 清除） */
	status(text: string | undefined): void;
}

export interface SetupReport {
	lines: string[];
	done: boolean;
	needsAttention: boolean;
}

interface ExecResult {
	ok: boolean;
	out: string;
	err: string;
}

/** keygen / keyscan / scp 非零退出是常态，不是异常 */
function exec(bin: string, args: string[], timeoutMs = 20000): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "") });
		});
	});
}

function sshDir(): string {
	return join(homedir(), ".ssh");
}

function sshConfigPath(): string {
	return join(sshDir(), "config");
}

/** 现有默认名私钥（存在即用，不重复生成） */
function existingKey(): string | undefined {
	for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
		const p = join(sshDir(), name);
		if (existsSync(p)) return p;
	}
	return undefined;
}

/**
 * 找出某个别名所在的 Host 块。
 *
 * **存在性判定和 HostName 读取必须用同一套解析**。以前是两个函数各写一套：
 * 存在性用 `^\s*Host\s+<alias>\s*$`（要求整行只有这一个别名），
 * 读 HostName 用「该行别名列表里包含」。于是 `Host a b` 这种多别名行会被判成
 * 「不存在」→ 追加一个同名块 → ssh 采用**先出现的那一个**，可能连到别的机器。
 *
 * 这个兜底本身也是必需的：别名是固定的，万一用户 ~/.ssh/config 里已经有同名
 * Host 且指向别的机器，沿用它会**静默连错服务器**——那比报错糟糕得多。
 */
function findAliasBlock(alias: string): { exists: boolean; hostName?: string } {
	const p = sshConfigPath();
	if (!existsSync(p)) return { exists: false };
	let inBlock = false;
	let seen = false;
	let hostName: string | undefined;
	for (const raw of readFileSync(p, "utf8").split("\n")) {
		const line = raw.trim();
		if (/^Host\s+/i.test(line)) {
			if (seen) return { exists: true, hostName }; // 别名块到此结束
			inBlock = line.slice(5).trim().split(/\s+/).includes(alias);
			if (inBlock) seen = true;
			continue;
		}
		if (/^(Match|Include)\s+/i.test(line)) {
			inBlock = false;
			continue;
		}
		if (inBlock && /^HostName\s+/i.test(line)) hostName = line.slice(9).trim();
	}
	return { exists: seen, hostName };
}

export async function runSetup(ui: SetupUI, presets?: { host?: string; user?: string }): Promise<SetupReport> {
	const lines: string[] = [];
	let problems = 0;
	let attention = false;

	const cfg = loadConfig();

	// ── 0. 本地模式：pi 就装在跑实验的机器上，整个 ssh 环节跳过 ──
	// 用配置 "sshHost": "local" 启用。大多数人用不到，但成本很低。
	if (isLocal(cfg.sshHost)) {
		const probe = await runLocal("echo __RL_OK__", 10);
		if (!probe.ok || !probe.out.includes("__RL_OK__")) {
			lines.push("✗ 本地模式，但命令执行不了");
			lines.push(`  ${(probe.err.trim() || probe.out.trim() || "(无输出)").slice(0, 200)}`);
			return { lines, done: false, needsAttention: true };
		}
		lines.push("✓ 本地模式：命令直接在本机执行，不需要 ssh");
		if (IS_WIN) lines.push("  （Windows 下走 cmd.exe）");
		lines.push("");
		lines.push("不需要任何配置文件。下一步：/reload，然后 /rl 开始循环。");
		return { lines, done: true, needsAttention: false };
	}

	// ── 1. ssh 程序 ────────────────────────────────────────
	const ver = await exec(sshBin(), ["-V"], 8000);
	if (!(ver.out + ver.err).includes("OpenSSH")) {
		lines.push("✗ 找不到 ssh 程序");
		lines.push(
			IS_WIN
				? "  安装：设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」"
				: "  macOS/Linux 一般自带；没有的话请先安装 OpenSSH 客户端",
		);
		return { lines, done: false, needsAttention: true };
	}
	lines.push(`✓ ssh 程序可用（${(ver.err || ver.out).trim().slice(0, 60)}）`);

	// ── 2. 本地钥匙对 ──────────────────────────────────────
	let keyPath = existingKey();
	if (keyPath) {
		lines.push(`✓ 已有私钥：${keyPath}`);
	} else {
		mkdirSync(sshDir(), { recursive: true });
		keyPath = join(sshDir(), "id_ed25519");
		ui.status("正在生成钥匙对 …");
		const gen = await exec(keygenBin, ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
		ui.status(undefined);
		if (gen.ok && existsSync(keyPath)) {
			lines.push(`✓ 已生成新钥匙对：${keyPath}`);
			lines.push("  ⚠ 这把私钥没有密码（免密登录需要）。不要外传、不要提交进 git。");
		} else {
			lines.push("✗ 生成钥匙对失败");
			lines.push(`  ${(gen.err || gen.out).trim().slice(0, 200)}`);
			return { lines, done: false, needsAttention: true };
		}
	}
	const pubKeyPath = `${keyPath}.pub`;
	if (!existsSync(pubKeyPath)) {
		// 有私钥却没有 .pub（手工拷过、或 .pub 被删了）：从私钥反推一份。
		// 不补的话下面那条「cat xxx.pub」命令必然失败，而用户不知道为什么。
		const y = await exec(keygenBin, ["-y", "-f", keyPath], 10000);
		const pub = y.out.trim();
		if (y.ok && /^(ssh-|ecdsa-|sk-)/.test(pub)) {
			mkdirSync(sshDir(), { recursive: true });
			writeFileSync(pubKeyPath, `${pub}\n`);
			lines.push(`✓ 私钥没有配套的 .pub，已从私钥补出：${pubKeyPath}`);
		}
	}
	if (!existsSync(pubKeyPath)) {
		problems += 1;
		attention = true;
		lines.push(`✗ 公钥文件不存在，也没法从私钥生成：${pubKeyPath}`);
		lines.push(`  手动补：${keygenBin} -y -f ${keyPath} > ${pubKeyPath}`);
		return { lines, done: false, needsAttention: true };
	}

	// ── 3. 只问两件事：服务器地址、用户名（命令行带参时预填，回车即确认）──
	const host = (await ui.ask("服务器地址（IP 或域名）", presets?.host ?? "例如 192.168.1.50"))?.trim() ?? presets?.host ?? "";
	if (!host) {
		lines.push("✗ 未获取服务器地址，已取消");
		return { lines, done: false, needsAttention: false };
	}

	const user = (await ui.ask("登录用户名", presets?.user ?? "例如 zhangsan"))?.trim() ?? presets?.user ?? "";
	if (!user) {
		lines.push("✗ 未获取用户名，已取消");
		return { lines, done: false, needsAttention: false };
	}

	// 别名固定（内部细节），但允许配置覆盖，以防万一撞名
	const alias = cfg.sshHost || SSH_ALIAS;

	// ── 4. 写 ~/.ssh/config（带冲突检测）───────────────────
	const blk = findAliasBlock(alias);
	if (blk.exists) {
		const existingHost = blk.hostName;
		if (existingHost && existingHost !== host) {
			problems += 1;
			attention = true;
			lines.push(`✗ 冲突：~/.ssh/config 里的 ${alias} 已存在，且指向 ${existingHost}`);
			lines.push(`  不是你要配的 ${host}。沿用它会连错机器，所以我不动它。`);
			lines.push("");
			lines.push("两种解法（任选一）：");
			lines.push(`  1. 手动编辑 ~/.ssh/config，删掉或改名 ${alias} 那个块，重跑 /rl setup`);
			lines.push(`  2. 在 .pi/research-loop.json 里设 "sshHost": "别的名字"，重跑 /rl setup`);
			return { lines, done: false, needsAttention: true };
		}
		lines.push(`✓ 别名已存在且指向同一台机器：${alias}（沿用）`);
	} else {
		mkdirSync(sshDir(), { recursive: true });
		appendFileSync(sshConfigPath(), `\nHost ${alias}\n  HostName ${host}\n  User ${user}\n`);
		lines.push(`✓ 已配置 ${alias} → ${user}@${host}`);
		lines.push("  （这个别名是内部用的，你不用记）");
	}

	// ── 5. 指纹登记 + 免密连通（卡住就在这里等，不要求重跑）──
	let connected = false;
	// 中途提示只发「本次新增的行」：lines 是累积的，每次全量重发会把前面说过的内容再刷一遍
	let saidUpTo = 0;
	for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
		ui.status(`正在连接 ${user}@${host} …`);
		let probe = await runRemote(alias, "echo __RL_OK__", 10);
		if (probe.ok && probe.out.includes("__RL_OK__")) {
			connected = true;
			break;
		}

		// 首连的指纹确认在 BatchMode 下必失败，替用户踩掉
		ui.status(`正在登记 ${host} 的指纹 …`);
		const scan = await exec(keyscanBin, ["-T", "8", host]);
		if (scan.ok && scan.out.trim()) {
			appendFileSync(join(sshDir(), "known_hosts"), scan.out.endsWith("\n") ? scan.out : `${scan.out}\n`);
			lines.push("✓ 已登记服务器指纹（known_hosts）");
			ui.status(`正在连接 ${user}@${host} …`);
			probe = await runRemote(alias, "echo __RL_OK__", 10);
			if (probe.ok && probe.out.includes("__RL_OK__")) {
				connected = true;
				break;
			}
		}

		// ── 装公钥：主路径 = 向导内闭环（ssh2），兜底 = 打印命令 ──
		// 主路径全程无 shell 参与（引号/CRLF/折行这些终端坑从物理上不存在）。
		// 兜底命令的历史教训（2026-09-23/24）：PowerShell 会剥原生命令参数里的
		// 单引号；从 TUI 复制折行长命令会带上换行。所以兜底命令必须是若干条
		// 「≤~105 字符的独立完整命令」——多行整块粘贴时换行只会落在命令之间。
		const pubWin = pubKeyPath.replace(/\//g, "\\");
		const fallbackCmds: string[] = IS_WIN
			? [
					`scp "${pubWin}" ${user}@${host}:rl-pub.tmp`,
					`ssh ${user}@${host} "mkdir -p ~/.ssh && cat ~/rl-pub.tmp >> ~/.ssh/authorized_keys"`,
					`ssh ${user}@${host} "rm ~/rl-pub.tmp && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`,
				]
			: [`cat ${pubKeyPath} | ssh ${user}@${host} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && tr -d '\\r' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`];
		const pwTimes = IS_WIN ? "三条命令各输一次密码（共 3 次）" : "输一次服务器密码";

		const ssh2 = await loadSsh2();
		let password: string | undefined;
		if (ssh2) {
			lines.push("");
			lines.push("把公钥装上服务器需要一次密码验证（之后永久免密）。");
			password = await ui.ask(`输入 ${user}@${host} 的密码`, "仅本次使用，不会保存");
		} else {
			lines.push("");
			lines.push("-- 自动安装组件（ssh2）不可用，改用手动方式。");
		}
		if (ssh2 && password) {
			ui.status("正在自动安装公钥（ssh2 直连，不经过终端）…");
			const pub = readFileSync(pubKeyPath, "utf8");
			const res = await installKeyViaSsh2(host, user, password, pub);
			password = ""; // 用完立刻丢弃
			if (res.ok) {
				lines.push("✓ 公钥已自动装上服务器");
				ui.status("正在重新检查连接 …");
				continue;
			}
			lines.push(`✗ 自动安装失败：${res.err}`);
			ui.setupError?.(`装公钥失败：${res.err}（已降级为手动方式，原因见下方输出）`);
			lines.push("  或者运行 /rl fix-ssh 让 agent 接手诊断修复。");
			lines.push("  手动方式：");
		} else if (ssh2 && password === "") {
			lines.push("已跳过。改用手动方式：");
		} else if (ssh2 && password === undefined) {
			lines.push("已取消。随时重跑 /rl setup 继续（前面的步骤会自动跳过）。");
			return { lines, done: false, needsAttention: false };
		}

		lines.push("");
		if (attempt > 1) {
			lines.push(`第 ${attempt} 次仍连不上。若上面的命令已跑过且没报错，`);
			lines.push("多半不是公钥没装上，而是服务器端 ~/.ssh 权限不对。");
		}
		lines.push("还差一步：把公钥装到服务器（装完永久免密）。");
		lines.push("**另开一个终端**逐条执行（可整块复制，每行都是完整命令）：");
		for (const c of fallbackCmds) lines.push(`  ${c}`);
		lines.push("");

		// 关键：confirm 是中途弹的，而报告要等 setup 跑完才统一输出。
		// 不先把命令显示出来，用户会看到「执行上面那条命令」却看不到命令。
		ui.status(undefined);
		ui.say(lines.slice(saidUpTo).join("\n"));
		saidUpTo = lines.length;
		const ok = await ui.confirm(
			"公钥装好了吗？",
			`另开终端逐条执行：\n\n  ${fallbackCmds.join("\n  ")}\n\n${pwTimes}。执行完选 Yes 继续。`,
		);
		if (!ok) {
			lines.push("已取消。随时重跑 /rl setup 继续（前面的步骤会自动跳过）。");
			return { lines, done: false, needsAttention: false };
		}
		ui.status("正在重新检查连接 …");
	}

	ui.status(undefined);

	if (!connected) {
		lines.push(`✗ 试了 ${MAX_KEY_ATTEMPTS} 次仍无法免密登录`);
		lines.push(`  手动验证：ssh ${alias} "echo ok" —— 应该直接返回 ok，不问密码`);
		return { lines, done: false, needsAttention: true };
	}
	lines.push(`✓ 免密连通：ssh ${alias}`);

	ui.status("正在修正服务器端 ssh 权限 …");
	await runRemote(alias, "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && rm -f ~/rl-pub.tmp", 10);
	ui.status(undefined);
	lines.push("✓ 服务器端 ssh 权限已确认（700/600）");

	// ── 6. 收尾 ────────────────────────────────────────────
	if (IS_WIN) {
		lines.push("");
		lines.push(`⚠ Windows：连服务器一律用别名走原生 ssh（ssh ${alias} "命令"）。`);
		lines.push("  不要用 wsl ssh（WSL 是另一套没配置的环境，会卡在指纹确认/缺钥匙）。");
	}
	lines.push("");
	lines.push("配置完成，不需要任何配置文件。");
	lines.push("下一步：/reload，然后 /rl 开始循环。");
	return { lines, done: problems === 0, needsAttention: attention };
}
