import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_NAME = "research-loop.json";

/** 配置里还没填的值。填之前扩展拒绝启动，避免空转烧 token。 */
export const PLACEHOLDER = "TODO";

/**
 * 固定的 ssh 别名。
 *
 * 这是**实现细节**，不需要用户理解或配置：`/rl setup` 只问服务器地址和用户名，
 * 然后自己把这个别名写进 `~/.ssh/config`。
 *
 * 名字取得比较特殊，避免和用户已有的 Host 撞车。
 * 万一真撞了（且指向别的机器），setup 会检测到并报错，不会静默连错服务器。
 *
 * 想换别名的话，在配置里写 `sshHost`（见 SSH_ALIAS 的使用处）覆盖即可。
 */
export const SSH_ALIAS = "research-loop-server";

export interface Config {
	/** agent 维护的待检查表：一行一个服务器绝对路径 */
	runsFile: string;
	/** table 模式：登记后超过这么久还没 DONE 就提醒（兜底，防静默失联） */
	maxHours: number;
	/** ~/.ssh/config 里配好的服务器 Host 别名（免密 key） */
	sshHost: string;
	/** 轮询间隔（秒） */
	pollIntervalSec: number;
	/** 合并窗口（秒）：攒一批再唤醒，且两次唤醒至少间隔这么久 */
	mergeWindowSec: number;
	sshTimeoutSec: number;
	/** ssh 连续失败多少次后升级给 LLM */
	sshFailEscalate: number;
	/**
	 * 模型链：额度耗尽时按这个顺序往下切。
	 * 只在**全局**配置里有意义——模型可用性取决于这台机器登录了哪些 provider。
	 * 空数组 = 不做自动切换。
	 */
	modelChain: string[];
	/** 错误文案里抠不出「多久恢复」时，用这个小时数冷却 */
	cooldownHours: number;
}

export const DEFAULTS: Config = {
	runsFile: ".auto/runs.csv",
	maxHours: 72,
	sshHost: SSH_ALIAS,

	pollIntervalSec: 60,
	mergeWindowSec: 60,
	sshTimeoutSec: 15,
	sshFailEscalate: 3,
	modelChain: [],
	cooldownHours: 5,
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
	// sshHost 有默认值（固定别名），所以开箱即用，不需要任何配置文件
	return Boolean(c.sshHost);
}
