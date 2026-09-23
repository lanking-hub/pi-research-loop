/**
 * /rl setup 的实现 —— 从零到可用的断点续跑向导。
 *
 * 设计约束：
 *   - 每一步都幂等：已完成的自动跳过，所以可以反复执行，卡在哪一步就重跑到哪一步
 *   - 唯一需要人的环节：把公钥装上服务器（要输最后一次密码），这一步打印
 *     按平台给好的复制粘贴命令，装完重跑 /rl setup 继续
 *   - 不依赖任何交互式 API：全部通过命令参数 + 通知输出完成
 *
 * 用法：/rl setup <服务器IP或域名> <用户名> [别名]
 *   别名缺省 research-server；后续配置里的 sshHost 填这个别名。
 *   不带参数时，对已配置的 sshHost 别名做「只补缺」式整备。
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSsh, sshBin } from "./ssh.ts";

const IS_WIN = process.platform === "win32";
const scpBin = IS_WIN ? "scp.exe" : "scp";
const keyscanBin = IS_WIN ? "ssh-keyscan.exe" : "ssh-keyscan";
const keygenBin = IS_WIN ? "ssh-keygen.exe" : "ssh-keygen";

const DEFAULT_ALIAS = "research-server";

interface ExecResult {
	ok: boolean;
	out: string;
	err: string;
}

/** 和 runSsh 同款，但给 keygen / keyscan / scp 用（它们非零退出是常态，不是异常） */
function exec(bin: string, args: string[], timeoutMs = 20000): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			bin,
			args,
			{ timeout: timeoutMs, windowsHide: true },
			(error, stdout, stderr) => {
				resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "") });
			},
		);
	});
}

function sshDir(): string {
	return join(homedir(), ".ssh");
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
	const p = join(sshDir(), "config");
	if (!existsSync(p)) return false;
	return new RegExp(`^\\s*Host\\s+${escapeRegExp(alias)}\\s*$`, "m").test(readFileSync(p, "utf8"));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SetupInput {
	/** 服务器 IP 或域名；与 alias 二选一提供（有 host 时会写/查别名） */
	host?: string;
	/** 服务器用户名 */
	user?: string;
	/** ~/.ssh/config 里的别名；缺省 research-server */
	alias?: string;
	/** 配置里已填的 runsPath（服务器端建目录用），未填则跳过 */
	runsPath?: string;
}

export interface SetupReport {
	lines: string[];
	/** true = 全部完成；false = 停在需要人工的一步（按提示操作后重跑） */
	done: boolean;
	needsAttention: boolean;
}

export async function setup(input: SetupInput): Promise<SetupReport> {
	const lines: string[] = [];
	let problems = 0;
	let attention = false;

	const alias = input.alias || DEFAULT_ALIAS;

	// ── 第 1 步：ssh 程序存在 ──────────────────────────────
	const ver = await exec(sshBin(), ["-V"], 8000);
	if ((ver.out + ver.err).includes("OpenSSH")) {
		lines.push(`✓ ssh 程序可用（${(ver.err || ver.out).trim()}）`);
	} else {
		problems += 1;
		attention = true;
		lines.push("✗ 找不到 ssh 程序");
		lines.push(IS_WIN ? "  安装：设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」" : "  macOS 自带；若无：sudo sysdiagnose 或重装系统组件");
		return { lines: [...lines, "", "后续步骤需要 ssh，装好后重跑 /rl setup"], done: false, needsAttention: attention };
	}

	// ── 第 2 步：本地钥匙对 ────────────────────────────────
	let keyPath = existingKey();
	if (keyPath) {
		lines.push(`✓ 已有私钥：${keyPath}`);
	} else {
		mkdirSync(sshDir(), { recursive: true });
		keyPath = join(sshDir(), "id_ed25519");
		const gen = await exec(keygenBin, ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
		if (gen.ok && existsSync(keyPath)) {
			lines.push(`✓ 已生成新钥匙对：${keyPath}`);
		} else {
			problems += 1;
			attention = true;
			lines.push("✗ 生成钥匙对失败");
			lines.push(`  ${(gen.err || gen.out).trim().slice(0, 200)}`);
			return { lines: [...lines, "", "处理后重跑 /rl setup"], done: false, needsAttention: attention };
		}
	}
	const pubKeyPath = `${keyPath}.pub`;

	// ── 第 3 步：别名（~/.ssh/config）───────────────────────
	const effectiveAlias = alias;
	if (input.host) {
		if (configHasAlias(alias)) {
			lines.push(`✓ 别名已存在：${alias}（沿用，不改动）`);
		} else {
			mkdirSync(sshDir(), { recursive: true });
			appendFileSync(
				join(sshDir(), "config"),
				`\nHost ${alias}\n  HostName ${input.host}\n  User ${input.user || "TODO"}\n`,
			);
			lines.push(`✓ 已写入别名 ${alias} → ${input.user || "TODO"}@${input.host}`);
			if (!input.user) {
				lines.push("  ⚠ 未提供用户名，config 里的 User 是 TODO，记得改");
				problems += 1;
			}
		}
	} else {
		// 没给 host：本模式只对已存在的别名整备
		if (configHasAlias(alias)) {
			lines.push(`✓ 使用已配置的别名：${alias}`);
		} else {
			problems += 1;
			attention = true;
			lines.push(`✗ ~/.ssh/config 里没有别名 ${alias}`);
			lines.push(`  用法：/rl setup <服务器IP> <用户名> [别名]`);
			return { lines: [...lines, "", "补上参数重跑 /rl setup"], done: false, needsAttention: attention };
		}
	}

	// ── 第 4 步：连通（指纹登记 → 公钥安装）────────────────
	let probe = await runSsh(effectiveAlias, "echo __RL_SETUP_OK__", 10);
	if (!probe.ok || !probe.out.includes("__RL_SETUP_OK__")) {
		// 先补指纹（首连交互确认在 BatchMode 下必失败，这里替用户踩掉）
		if (input.host) {
			const scan = await exec(keyscanBin, ["-T", "8", input.host]);
			if (scan.ok && scan.out.trim()) {
				appendFileSync(join(sshDir(), "known_hosts"), scan.out.endsWith("\n") ? scan.out : scan.out + "\n");
				lines.push(`✓ 已登记服务器指纹（known_hosts）`);
				probe = await runSsh(effectiveAlias, "echo __RL_SETUP_OK__", 10);
			} else {
				lines.push(`-- 指纹登记未完成（服务器可能暂不可达）：${(scan.err || scan.out).trim().slice(0, 120)}`);
			}
		}
	}
	if (probe.ok && probe.out.includes("__RL_SETUP_OK__")) {
		lines.push(`✓ 免密连通：ssh ${effectiveAlias}`);
	} else {
		// 最常见的剩因：公钥还没装上服务器。打印按平台的安装命令，人工执行（输一次密码）。
		problems += 1;
		attention = true;
		lines.push("✗ 还不能免密登录（公钥大概率未装到服务器）");
		lines.push("");
		lines.push("请复制下面这条命令执行，输一次服务器密码（装公钥，一劳永逸）：");
		if (IS_WIN) {
			lines.push(`  type "${pubKeyPath.replace(/\//g, "\\")}" | ssh ${input.user ? `${input.user}@${input.host}` : effectiveAlias} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`);
		} else {
			lines.push(`  ssh-copy-id ${input.user ? `${input.user}@${input.host}` : effectiveAlias}`);
		}
		lines.push("");
		lines.push("装完后重跑 /rl setup，会自动继续服务器端的整备。");
		return { lines, done: false, needsAttention: attention };
	}

	// ── 第 5 步：服务器端整备（权限/目录/脚本/验证）────────
	const chmod = await runSsh(effectiveAlias, "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys", 10);
	lines.push(chmod.ok ? "✓ 服务器端 ssh 权限已确认（700/600）" : "-- 权限修正跳过（可能没有 authorized_keys，装公钥时已处理）");

	const binDir = await runSsh(effectiveAlias, "mkdir -p ~/bin && echo ok", 10);
	if (binDir.ok) {
		const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "server");
		let uploaded = 0;
		for (const script of ["run_status.sh", "run_exp.sh"]) {
			const src = join(serverDir, script);
			if (!existsSync(src)) {
				lines.push(`-- 本地找不到 ${script}，跳过上传`);
				continue;
			}
			const up = await exec(scpBin, [src, `${effectiveAlias}:bin/${script}`], 60000);
			if (up.ok) {
				await runSsh(effectiveAlias, `chmod +x ~/bin/${script}`, 10);
				uploaded += 1;
			} else {
				problems += 1;
				lines.push(`✗ 上传 ${script} 失败：${(up.err || up.out).trim().slice(0, 150)}`);
			}
		}
		if (uploaded > 0) lines.push(`✓ 管理脚本已上传并赋执行权限（~/bin/，共 ${uploaded} 个）`);
	} else {
		problems += 1;
		lines.push("✗ 服务器上建 ~/bin 失败");
	}

	if (input.runsPath) {
		const mk = await runSsh(effectiveAlias, `mkdir -p ${JSON.stringify(input.runsPath)} && echo ok`, 10);
		lines.push(mk.ok ? `✓ runs 目录就绪：${input.runsPath}` : `✗ 建 runs 目录失败：${input.runsPath}`);
		if (!mk.ok) problems += 1;
	} else {
		lines.push("-- runsPath 未配置，跳过建目录（填好配置后重跑 setup 会补上）");
	}

	// ── 第 6 步：平台提醒 ──────────────────────────────────
	if (IS_WIN) {
		lines.push("");
		lines.push("⚠ Windows 提醒：连服务器永远用别名走原生 ssh（ssh " + effectiveAlias + ' "命令"）。');
		lines.push("  不要用 wsl ssh（WSL 是另一套没配置的环境，会卡在指纹确认/缺钥匙）。");
		lines.push("  这条同样写给 agent：已写进 AGENTS.md 模板的 SSH 纪律。");
	}

	lines.push("");
	lines.push(problems > 0 ? `共 ${problems} 项待处理` : "全部就绪：把配置里的 sshHost 填成 " + effectiveAlias + "，然后 /rl doctor 复查、/rl start 开跑");
	return { lines, done: problems === 0, needsAttention: attention };
}

export { DEFAULT_ALIAS };
