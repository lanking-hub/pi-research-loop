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
	/**
	 * 输出目录连续这么久**没有任何文件更新** → 提醒「疑似卡住」。
	 *
	 * 这是判断实验还活着不活着的**主要信号**：实验该跑多久根本没法预先知道
	 * （5 个 epoch 和 200 个 epoch 差几十倍），但「还在产出」是通用的。
	 * 只在 Slurm/Docker 拿不到 pid、或进程活着却卡死时才真正需要。
	 */
	stallMinutes: number;
	/**
	 * 登记后超过这么久还没 DONE 就提醒。
	 *
	 * **最后的兜底**，管的是 stallMinutes 抓不到的情况：一直在写日志却永远不结束
	 * （比如死循环疯狂打印）。正常卡死由 stallMinutes 更早发现。
	 */
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
	/**
	 * 冷却小时数。模型报额度问题时先晾这么久，之后自然回到链头再试。
	 *
	 * 刻意取**短**（1 小时）而不是去猜 provider 说的恢复时间：
	 * 各家文案措辞五花八门，抠不准；而一次失败调用的代价很低（额度错误
	 * 不消耗 token），用「低频重试」比「精确算恢复时间」简单也够用。
	 * 只有当文案明确给出**更长**的恢复时间时才按它的来，免得白跑一趟。
	 */
	cooldownHours: number;
}

export const DEFAULTS: Config = {
	runsFile: ".auto/runs.csv",
	stallMinutes: 90,
	maxHours: 72,
	sshHost: SSH_ALIAS,

	pollIntervalSec: 60,
	mergeWindowSec: 60,
	sshTimeoutSec: 15,
	sshFailEscalate: 3,
	modelChain: [],
	cooldownHours: 1,
};

/**
 * 配置查找顺序：全局 → 项目级。项目级覆盖全局。
 * 两台机器（比如 Mac / Windows）可以各有一份不同的全局配置。
 */
export function configPaths(): string[] {
	return [join(homedir(), ".pi", "agent", CONFIG_NAME), join(process.cwd(), ".pi", CONFIG_NAME)];
}

/**
 * 把一个配置值转成数字，转不出来返回 NaN。
 *
 * 只认 number 和非空 string。**必须显式排除 null 和 ""**：
 * `Number(null)` 和 `Number("")` 都是 0，真当成 0 用就糟了——
 * stallMinutes=0 会被 Math.max(1, 0) 兜成 1 分钟，等于每分钟报一次卡住。
 */
function toNumber(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "") return Number(v);
	return NaN;
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
				if (!(k in merged)) continue;
				// 数字字段填成非数字（"abc"、null、""）就忽略，用默认值。
				// 不拦的话这个值会原样拼进 shell：find ... -mmin -NaN → 报错被
				// 2>/dev/null 吃掉 → 永远判「活着」，功能静默失效且没有任何提示。
				if (typeof (DEFAULTS as unknown as Record<string, unknown>)[k] === "number") {
					const n = toNumber(v);
					if (!Number.isFinite(n)) continue;
					clean[k] = n;
					continue;
				}
				clean[k] = v;
			}
			merged = { ...merged, ...clean };
		} catch {
			// 配置损坏就跳过，用默认值继续
		}
	}
	return merged;
}

/**
 * 配置文件里**填了但填错**的数字字段（"abc"、null、""）。
 *
 * loadConfig 会静默忽略它们改用默认值——那是必要的兜底，但用户看不出来。
 * 这个函数给 doctor 一个能明确说出来的清单。
 */
export function invalidConfigKeys(): string[] {
	const bad = new Set<string>();
	for (const p of configPaths()) {
		try {
			if (!existsSync(p)) continue;
			const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
			for (const [k, v] of Object.entries(raw)) {
				if (v === PLACEHOLDER) continue;
				if (typeof (DEFAULTS as unknown as Record<string, unknown>)[k] !== "number") continue;
				if (!Number.isFinite(toNumber(v))) bad.add(k);
			}
		} catch {
			// 解析失败由 loadConfig 兜底，这里不重复报
		}
	}
	return [...bad];
}

export function isConfigured(c: Config): boolean {
	// sshHost 有默认值（固定别名），所以开箱即用，不需要任何配置文件
	return Boolean(c.sshHost);
}
