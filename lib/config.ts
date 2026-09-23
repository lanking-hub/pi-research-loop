import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_NAME = "research-loop.json";

/** 配置里还没填的值。填之前扩展拒绝启动，避免空转烧 token。 */
export const PLACEHOLDER = "TODO";

export interface Config {
	/**
	 * 两种盯实验的方式：
	 * - "table"（默认，迭代用）：agent 在 `runsFile` 里登记正在跑的实验路径，
	 *   轮询只检查这些路径下有没有 DONE。不假设实验怎么起，兼容性最好。
	 * - "dir"（baseline 用）：固定的 runs 目录 + 服务器脚本，结构强制统一。
	 */
	mode: "table" | "dir";
	/** table 模式：agent 维护的待检查表，一行一个服务器绝对路径 */
	runsFile: string;
	/** table 模式：登记后超过这么久还没 DONE 就提醒（兜底，防静默失联） */
	maxHours: number;
	/** ~/.ssh/config 里配好的服务器 Host 别名（免密 key） */
	sshHost: string;
	/** 服务器上 runs 目录的绝对路径 */
	runsPath: string;
	/** 服务器上状态脚本的调用命令，输出每行 "<runId> <STATE>" */
	statusCommand: string;
	/** 服务器上起实验脚本的调用命令 */
	startCommand: string;
	/** 查显卡占用的命令 */

	/** 轮询间隔（秒） */
	pollIntervalSec: number;
	/** 合并窗口（秒）：攒一批再唤醒，且两次唤醒至少间隔这么久 */
	mergeWindowSec: number;
	sshTimeoutSec: number;
	/** ssh 连续失败多少次后升级给 LLM */
	sshFailEscalate: number;
}

export const DEFAULTS: Config = {
	mode: "table",
	runsFile: ".auto/runs.txt",
	maxHours: 72,
	sshHost: PLACEHOLDER,
	runsPath: PLACEHOLDER,
	statusCommand: PLACEHOLDER,
	startCommand: PLACEHOLDER,

	pollIntervalSec: 60,
	mergeWindowSec: 60,
	sshTimeoutSec: 15,
	sshFailEscalate: 3,
};

/**
 * 配置查找顺序：全局 → 项目级。项目级覆盖全局。
 * 两台机器（比如 Mac / Windows）可以各有一份不同的全局配置。
 */
export function configPaths(): string[] {
	return [join(homedir(), ".pi", "agent", CONFIG_NAME), join(process.cwd(), ".pi", CONFIG_NAME)];
}

export function loadConfig(): Config {
	let merged: Config = { ...DEFAULTS };
	for (const p of configPaths()) {
		try {
			if (!existsSync(p)) continue;
			const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
			const clean: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(raw)) {
				// 占位值不覆盖上一层已经填好的值，这样「部分填写的项目级配置」是安全的
				if (v === PLACEHOLDER) continue;
				if (k in merged) clean[k] = v;
			}
			merged = { ...merged, ...clean };
		} catch {
			// 配置损坏就跳过，用默认值继续
		}
	}
	return merged;
}

export function isConfigured(c: Config): boolean {
	if (c.sshHost === PLACEHOLDER) return false;
	// dir 模式还需要固定目录和状态脚本；table 模式只要能连上服务器就够了
	if (c.mode === "dir") return c.runsPath !== PLACEHOLDER && c.statusCommand !== PLACEHOLDER;
	return true;
}
