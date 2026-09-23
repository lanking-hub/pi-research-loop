/**
 * /rl setup —— 交互式一键整备向导。
 *
 * 设计原则：
 *   - **一次跑完**：需要人动手的环节（装公钥）在向导内部暂停等待确认，
 *     不要求用户「跑两遍」。
 *   - **每一步都问**：用 ctx.ui.input 逐个问，不要求用户在一条命令里把参数给全。
 *     已填过的配置作为默认值预填，减少打字。
 *   - **幂等**：已完成的步骤自动跳过，所以半途失败后重跑是安全的。
 *   - **自动写配置**：问到的信息直接落进项目级配置，不要求用户手填。
 *
 * 唯一躲不开的手动环节：把公钥装上服务器需要输一次服务器密码。
 * ssh 不从 stdin 读密码（安全设计），没有 PTY 就自动化不了，所以这一步
 * 打印命令 + 等待确认，而不是让用户重跑整个向导。
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_NAME, loadConfig, type Config } from "./config.ts";
import { serverDir } from "./paths.ts";
import { expandRemotePath, remoteHome, runSsh, sshBin } from "./ssh.ts";

const IS_WIN = process.platform === "win32";
const scpBin = IS_WIN ? "scp.exe" : "scp";
const keyscanBin = IS_WIN ? "ssh-keyscan.exe" : "ssh-keyscan";
const keygenBin = IS_WIN ? "ssh-keygen.exe" : "ssh-keygen";

const DEFAULT_ALIAS = "research-server";
const DEFAULT_RUNS = "~/runs";
const REMOTE_BIN = "~/bin";
const MAX_KEY_ATTEMPTS = 3;

/** 交互能力的最小接口——lib 不依赖 pi 的类型，方便单独测试 */
export interface SetupUI {
	/** 问一句，返回用户输入；取消返回 undefined */
	ask(title: string, placeholder?: string): Promise<string | undefined>;
	/** 等用户确认；取消返回 false */
	confirm(title: string, message: string): Promise<boolean>;
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

function configHasAlias(alias: string): boolean {
	const p = sshConfigPath();
	if (!existsSync(p)) return false;
	return new RegExp(`^\\s*Host\\s+${escapeRegExp(alias)}\\s*$`, "m").test(readFileSync(p, "utf8"));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectConfigPath(): string {
	return join(process.cwd(), ".pi", CONFIG_NAME);
}

/** 把问到的配置写进项目级配置，合并而非覆盖 */
function writeProjectConfig(patch: Partial<Config>, lines: string[]): void {
	const p = projectConfigPath();
	let current: Record<string, unknown> = {};
	try {
		if (existsSync(p)) current = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	} catch {
		current = {};
	}
	const merged = { ...current, ...patch };
	try {
		mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
		writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`);
		lines.push(`✓ 配置已写入 ${join(".pi", CONFIG_NAME)}`);
	} catch (e) {
		lines.push(`✗ 写配置失败：${e instanceof Error ? e.message : String(e)}`);
	}
}

export async function runSetup(ui: SetupUI): Promise<SetupReport> {
	const lines: string[] = [];
	let problems = 0;
	let attention = false;

	const cfg = loadConfig();

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
		const gen = await exec(keygenBin, ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
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

	// ── 3. 问服务器信息（已配置的作为默认值）─────────────────
	const knownAlias = cfg.sshHost !== "TODO" ? cfg.sshHost : undefined;

	const host = (await ui.ask("服务器地址（IP 或域名）", knownAlias ?? "例如 192.168.1.50"))?.trim();
	if (!host) {
		lines.push("✗ 未获取服务器地址，已取消");
		return { lines, done: false, needsAttention: false };
	}

	const user = (await ui.ask("登录用户名", "例如 zhangsan"))?.trim();
	if (!user) {
		lines.push("✗ 未获取用户名，已取消");
		return { lines, done: false, needsAttention: false };
	}

	const aliasInput = (await ui.ask("ssh 别名（直接回车用默认）", knownAlias ?? DEFAULT_ALIAS))?.trim();
	const alias = aliasInput || knownAlias || DEFAULT_ALIAS;

	// ── 4. 写 ~/.ssh/config ────────────────────────────────
	if (configHasAlias(alias)) {
		lines.push(`✓ 别名已存在：${alias}（沿用，不改动）`);
	} else {
		mkdirSync(sshDir(), { recursive: true });
		appendFileSync(sshConfigPath(), `\nHost ${alias}\n  HostName ${host}\n  User ${user}\n`);
		lines.push(`✓ 已写入别名 ${alias} → ${user}@${host}`);
	}

	// ── 5. 指纹登记 + 免密连通（卡住就在这里等，不要求重跑）──
	let connected = false;
	for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
		let probe = await runSsh(alias, "echo __RL_OK__", 10);
		if (probe.ok && probe.out.includes("__RL_OK__")) {
			connected = true;
			break;
		}

		// 首连的指纹确认在 BatchMode 下必失败，替用户踩掉
		const scan = await exec(keyscanBin, ["-T", "8", host]);
		if (scan.ok && scan.out.trim()) {
			appendFileSync(join(sshDir(), "known_hosts"), scan.out.endsWith("\n") ? scan.out : `${scan.out}\n`);
			lines.push("✓ 已登记服务器指纹（known_hosts）");
			probe = await runSsh(alias, "echo __RL_OK__", 10);
			if (probe.ok && probe.out.includes("__RL_OK__")) {
				connected = true;
				break;
			}
		}

		// 还连不上 = 公钥大概率没装。给命令，等用户执行完确认。
		const installCmd = IS_WIN
			? `type "${pubKeyPath.replace(/\//g, "\\")}" | ssh ${user}@${host} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`
			: `cat ${pubKeyPath} | ssh ${user}@${host} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`;

		lines.push("");
		lines.push("还差一步：把公钥装到服务器（需要输一次服务器密码，之后永久免密）。");
		lines.push("请**另开一个终端**执行：");
		lines.push(`  ${installCmd}`);
		lines.push("");

		const ok = await ui.confirm("装好了吗？", "执行完上面那条命令后选 Yes，我会继续后面的整备");
		if (!ok) {
			lines.push("已取消。随时重跑 /rl setup 继续（前面的步骤会自动跳过）。");
			return { lines, done: false, needsAttention: false };
		}
	}

	if (!connected) {
		lines.push(`✗ 试了 ${MAX_KEY_ATTEMPTS} 次仍无法免密登录`);
		lines.push(`  手动验证：ssh ${alias} "echo ok" —— 应该直接返回 ok，不问密码`);
		return { lines, done: false, needsAttention: true };
	}
	lines.push(`✓ 免密连通：ssh ${alias}`);

	// ── 6. 服务器端整备 ────────────────────────────────────
	await runSsh(alias, "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys", 10);
	lines.push("✓ 服务器端 ssh 权限已确认（700/600）");

	const binDir = await runSsh(alias, `mkdir -p ${REMOTE_BIN} && echo ok`, 10);
	if (!binDir.ok) {
		problems += 1;
		attention = true;
		lines.push(`✗ 服务器上建 ${REMOTE_BIN} 失败`);
	} else {
		let uploaded = 0;
		for (const script of ["run_status.sh", "run_exp.sh"]) {
			const src = join(serverDir(), script);
			if (!existsSync(src)) {
				lines.push(`-- 本地找不到 ${script}，跳过上传`);
				continue;
			}
			const up = await exec(scpBin, [src, `${alias}:bin/${script}`], 60000);
			if (up.ok) {
				await runSsh(alias, `chmod +x ${REMOTE_BIN}/${script}`, 10);
				uploaded += 1;
			} else {
				problems += 1;
				lines.push(`✗ 上传 ${script} 失败：${(up.err || up.out).trim().slice(0, 150)}`);
			}
		}
		if (uploaded > 0) lines.push(`✓ 管理脚本已上传并赋执行权限（${REMOTE_BIN}/，共 ${uploaded} 个）`);
	}

	// ── 7. 问路径（~/ 会展开成服务器上的绝对路径再落盘）──────
	const home = await remoteHome(alias, 10);
	const runsDefault = cfg.runsPath !== "TODO" ? cfg.runsPath : DEFAULT_RUNS;
	const runsRaw = (await ui.ask("服务器上 runs 目录路径（放实验结果）", runsDefault))?.trim() || runsDefault;
	const runsPath = expandRemotePath(runsRaw, home);
	if (runsPath !== runsRaw) lines.push(`  （${runsRaw} → ${runsPath}）`);

	const mk = await runSsh(alias, `mkdir -p ${JSON.stringify(runsPath)} && echo ok`, 10);
	if (mk.ok) {
		lines.push(`✓ runs 目录就绪：${runsPath}`);
	} else {
		problems += 1;
		attention = true;
		lines.push(`✗ 建 runs 目录失败：${runsPath}`);
	}

	const projectRaw = (await ui.ask("服务器上项目目录路径（跑实验的地方）"))?.trim();
	const projectPath = projectRaw ? expandRemotePath(projectRaw, home) : undefined;
	if (!projectPath) {
		problems += 1;
		attention = true;
		lines.push("✗ 未提供项目路径，startCommand 无法生成（重跑 /rl setup 补上即可）");
	} else if (projectPath !== projectRaw) {
		lines.push(`  （${projectRaw} → ${projectPath}）`);
	}

	// ── 8. 自动写配置 ──────────────────────────────────────
	const patch: Partial<Config> = {
		sshHost: alias,
		runsPath,
		statusCommand: `RUNS_DIR=${runsPath} ${REMOTE_BIN}/run_status.sh`,
	};
	if (projectPath) {
		patch.startCommand = `RUNS_DIR=${runsPath} PROJECT_DIR=${projectPath} ${REMOTE_BIN}/run_exp.sh`;
	}
	writeProjectConfig(patch, lines);

	// ── 9. 平台提醒 ────────────────────────────────────────
	if (IS_WIN) {
		lines.push("");
		lines.push(`⚠ Windows：连服务器一律用别名走原生 ssh（ssh ${alias} "命令"）。`);
		lines.push("  不要用 wsl ssh（WSL 是另一套没配置的环境，会卡在指纹确认/缺钥匙）。");
	}

	lines.push("");
	lines.push(problems > 0 ? `共 ${problems} 项待处理` : "全部就绪。下一步：/reload，然后 /rl doctor 复查、/rl start 开跑");
	return { lines, done: problems === 0, needsAttention: attention };
}

export { DEFAULT_ALIAS };
