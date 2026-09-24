/**
 * research-loop — 自主科研迭代循环的驱动器
 *
 * 目的：让 agent 持续迭代你的**方法和代码**。
 * 实验只是验证手段；轮询只是为了让循环不停下来的触发器。
 * agent 每轮真正的工作是「看结果 → 改方法/代码 → 起下一个实验验证」。
 *
 * 扩展只做两件事：
 *   1. 定时问服务器：登记的实验有结果了吗
 *   2. 有结果就唤醒 agent，让它继续迭代
 *
 * 它刻意不判定任何事：不认识指标、不做 keep/discard、不决定下一步做什么。
 * 领域规则全部在 AGENTS.md（见 templates/）里，由人维护。
 *
 * 命令（默认动作 = 开始循环）：
 *   /rl            开始循环。没有实验在跑时会**主动让 agent 开局**——
 *                  扩展只会被「实验有结果」触发，不这么做的话第一次按 /rl 永远没反应
 *   /rl <一句话>    开始循环，并把这句话交给 agent 当第一轮任务
 *   /rl stop       停止
 *   /rl status     看状态
 *   /rl goal <文本> 往 goal 的「临时建议」加一条，下一轮自动生效
 *                  （-t <名字> 写到 .auto/goal-<名字>.md，多数情况用不到）
 *   /rl agents     项目里已有 AGENTS.md 时，让 agent 帮你合并（去重 + 精简），
 *                  背景提取自你的文档放在块外，规则块逐字保留
 *   /rl models     编辑模型链（键盘排序，存全局配置）。额度耗尽时按链顺序切换；
 *                  限流/过载/网络不换（pi 自己会重试），鉴权失败不换（得修配置）
 *   /rl doctor     逐项实测环境，告诉你还差什么（只读体检）
 *   /rl help       显示所有命令的说明
 *   /rl setup      首次一站式：生成项目文件（AGENTS.md / goal / notes / runs.csv）
 *                  + 交互式配 ssh（生成钥匙、写别名、登记指纹）
 *                  唯一人工环节（装公钥）在向导内输一次服务器密码即可，由 ssh2
 *                  直连自动完成（不经过任何终端，无复制粘贴）；依赖缺失时退回
 *                  打印命令的兜底模式。每步幂等，半途失败后重跑是安全的。
 *
 * 配置：**可选**。零配置就能跑（ssh 别名是固定常量，`/rl setup` 自动写进
 *       ~/.ssh/config）。想调参才建 `<项目>/.pi/research-loop.json`，字段见 docs/reference.md。
 *
 * 唯一的契约：agent 在登记表里写一条**服务器上的绝对路径**，
 *           实验结束时在那个目录下写 `DONE`。扩展只认这一个信号——
 *           实验怎么起（nohup / sbatch / docker / conda）它完全不关心。
 *
 * 注意：这个文件只能存在于一个位置。如果它同时出现在
 *   ~/.pi/agent/extensions/  和  <项目>/.pi/extensions/
 * 会被 pi 加载两次，导致重复唤醒。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CONFIG_NAME,
	invalidConfigKeys,
	isConfigured,
	loadConfig,
	PLACEHOLDER,
	SSH_ALIAS,
	type Config,
} from "../lib/config.ts";
import {
	classify,
	emptyState,
	type ErrorSignal,
	extractCooldownMinutes,
	keyOf,
	markCooldown,
	missingEntries,
	pickAvailable,
	type ChainCandidate,
	type ChainState,
} from "../lib/model-chain.ts";
import { templatesDir } from "../lib/paths.ts";
import { runRemote } from "../lib/ssh.ts";
import { runSetup } from "../lib/setup.ts";
import {
	forget,
	loadState,
	markHandled,
	markStallWarn,
	resetSeen,
	stallWarnedRecently,
	touch,
	type RunWatch,
} from "../lib/state.ts";

/** 待唤醒队列里的一项：已经拼好的说明文字 */
interface PendingItem {
	key: string;
	lines: string[];
	/**
	 * 唤醒后怎么处置这条登记——**绝不能一律标「已处理」**。
	 *
	 *   handled  终态（完成 / 崩溃）：报一次就够，之后不再提
	 *   reset    超时：实验还在跑，只是时间长了。标记成已处理会把之后
	 *            真正出现的 DONE 永久跳过 → 实验静默失联。改成重新计时
	 *   stall    卡住：持续状态，只要还在卡每轮都满足，所以要节流，
	 *            否则每 60 秒唤醒一次 agent
	 */
	after: "handled" | "reset" | "stall";
}

/** 给远程 shell 用的单引号包裹（路径里可能含空格） */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\''`)}'`;
}

// ── 模型链 ────────────────────────────────────────────
/** 各模型的冷却到期时间（内存即可：进程一停本来也就不轮询了） */
let chainState: ChainState = emptyState();
/** 最近一次发给 agent 的文本——换模型后要带着它重发 */
let lastPrompt: string | undefined;
/** 连续换模型重试的次数，防止整条链反复绕 */
let failoverTried = 0;

/** 模型的最小结构。不直接依赖 pi 的 Model 类型，免得类型对不齐。 */
interface SimpleModel {
	provider?: string;
	id?: string;
	name?: string;
}

/**
 * 这台机器上能切过去的模型。
 *
 * ⚠️ `scopedModels` 的语义容易搞反：它是**本会话的作用域限制**
 * （由 `--models` / `enabledModels` 决定），
 * **为空表示没有限制、所有已登录模型都能用**——不是「没有模型」。
 * 所以为空时要退回 `modelRegistry.getAvailable()`，否则会误报「没有可用模型」。
 */
function candidateList(): ChainCandidate<SimpleModel>[] {
	const c = lastCtx as
		| {
				scopedModels?: readonly { model?: SimpleModel }[];
				modelRegistry?: { getAvailable?: () => SimpleModel[] };
		  }
		| undefined;

	const scoped = c?.scopedModels ?? [];
	const raw: SimpleModel[] =
		scoped.length > 0
			? scoped.map((s) => s.model!).filter(Boolean)
			: (c?.modelRegistry?.getAvailable?.() ?? []);

	return raw
		.filter((m) => Boolean(m?.id))
		.map((m) => ({
			provider: String(m.provider ?? ""),
			id: String(m.id ?? ""),
			name: m.name ? String(m.name) : undefined,
			model: m,
		}));
}

function currentModelKey(): string {
	const m = (lastCtx as { model?: SimpleModel } | undefined)?.model;
	if (!m?.id) return "";
	return keyOf({ provider: String(m.provider ?? ""), id: String(m.id) });
}

/**
 * 把模型调到「链里第一个不在冷却中的」。
 *
 * 这一个动作同时实现了故障切换和**冷却后回切**——不需要单独的回切逻辑，
 * 也不需要后台定时器：轮询是零 token 的，模型只在要唤醒那一刻才重要。
 *
 * @returns false 表示链上挑不出能用的（都在冷却，或 setModel 都失败）。
 *          调用方**不要**据此停止循环：轮询是零 token 的，
 *          停了就没有下一次唤醒，冷却结束也回不来。
 */
async function ensureBestModel(pi: ExtensionAPI): Promise<boolean> {
	if (cfg.modelChain.length === 0) return true;
	const list = candidateList();
	if (list.length === 0) return true;

	const best = pickAvailable(cfg.modelChain, list, chainState, Date.now());
	if (!best) return false;

	const curKey = currentModelKey();
	const bestKey = keyOf(best);
	if (curKey && curKey === bestKey) return true;

	const ok = await pi.setModel(best.model as never);
	if (ok) {
		notify(`模型已切到 ${bestKey}`, curKey ? "warning" : "info");
		return true;
	}
	// setModel 返回 false = 这个 provider 没登录（换机器时 auth.json 不同步最常见）。
	// 标上冷却，避免同一轮里反复试它。
	markCooldown(chainState, bestKey, Date.now() + cfg.cooldownHours * 3600_000);
	notify(
		`切到 ${bestKey} 失败（多半是这个 provider 没登录），已跳过。\n用 /rl models 看这台机器实际可用的模型`,
		"warning",
	);
	return false;
}

/** 链上最早的冷却什么时候结束。全都冷却时告诉用户还要等多久，别让他以为卡死了 */
function cooldownEta(): string {
	const soon = Object.values(chainState.cooldownUntil).filter((t) => t > Date.now());
	if (soon.length === 0) return "";
	const mins = Math.max(1, Math.ceil((Math.min(...soon) - Date.now()) / 60000));
	return `最早 ${mins} 分钟后有模型恢复——那时再来实验结果就会自动继续。`;
}

/** 换模型后重发的话术：带上原文，但要求它先核对状态别重复干活 */
function resumePrompt(err: string): string {
	return [
		"你上一轮因为模型额度中断了，没能干完。",
		`原因：${err.slice(0, 300)}`,
		"现在已经换了一个模型继续。",
		"",
		"**先核对当前状态再动手**——.auto/notes.md、.auto/runs.csv，以及文件系统里实际变成什么样了，",
		"判断上次做到哪一步，从那里接着做。**不要重复已经完成的部分**（尤其不要重复起实验）。",
		"",
		"原来要做的事：",
		lastPrompt ?? "（见 .auto/goal.md 和 AGENTS.md）",
	].join("\n");
}

/**
 * agent_end 时判断是否因为额度中断；是的话当前模型进冷却、换下一个、重发。
 *
 * 只在 pi 自己放弃之后才介入：pi 内部已有重试逻辑，rate limit / 过载它会自己重试，
 * 等到 agent_end 还带着 quota 类错误，才轮到我们换模型。
 */
async function handleAgentEnd(pi: ExtensionAPI, messages: unknown[]): Promise<void> {
	if (cfg.modelChain.length === 0) return;
	// 只在循环运行时介入。循环停了之后你在手动对话，出错也不该自作主张重发上一轮的任务。
	if (!timer) return;

	// 找最后一条以错误终止的 assistant 消息。
	// 优先取 diagnostics 里的结构化错误码（比匹配文案可靠），取不到就用文案兜底。
	let errText = "";
	let sig: ErrorSignal | undefined;
	for (const raw of messages) {
		const m = raw as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			diagnostics?: {
				type?: string;
				error?: { code?: string | number; name?: string; message?: string };
			}[];
		};
		if (m?.role !== "assistant") continue;
		if (m.stopReason !== "error" && m.stopReason !== "aborted") continue;
		const d = [...(m.diagnostics ?? [])].reverse().find((x) => x?.error || x?.type);
		errText = m.errorMessage || d?.error?.message || "";
		if (errText || d?.error?.code !== undefined || d?.error?.name || d?.type) {
			sig = { code: d?.error?.code, name: d?.error?.name, type: d?.type, message: errText };
		}
	}

	if (!sig) {
		// 这一轮正常结束：清零，下一轮从链头开始
		failoverTried = 0;
		lastPrompt = undefined;
		return;
	}

	// 不是我们触发的这一轮（比如你在手动对话）→ 不自作主张重发
	if (!lastPrompt) return;

	const kind = classify(sig);
	if (kind === "auth") {
		notify(
			`鉴权失败，换模型也没用：${errText.slice(0, 200)}\n去检查这个 provider 的 key，或重新 /login`,
			"error",
		);
		return;
	}
	// rate / network / 认不出来 → pi 自己会重试，我们不换模型
	if (kind !== "quota") return;

	const curKey = currentModelKey();
	if (curKey) {
		// 冷却时长 = 默认 1 小时，但文案里明确给了**更长**的恢复时间就按它的来
		// （比如 "Try again in ~192 min"），免得 1 小时后白跑一趟。
		// 反过来文案给得更短（30s 那种）也不跟着缩短——重试太频繁没意义。
		const hinted = extractCooldownMinutes(errText);
		const mins = Math.max(cfg.cooldownHours * 60, hinted ?? 0);
		markCooldown(chainState, curKey, Date.now() + mins * 60_000);
	}

	failoverTried += 1;
	if (failoverTried > cfg.modelChain.length) {
		notify(
			`链上所有模型都额度耗尽了，已停止循环。\n恢复时间：${errText.slice(0, 120)}\n等额度恢复，或 /login 一个新的 provider 后用 /rl models 加进链`,
			"error",
		);
		stopPolling();
		return;
	}

	if (!(await ensureBestModel(pi))) {
		// 全链都在冷却 → **不停止循环**。轮询是零 token 的，等着就行。
		// 停了反而再也起不来：没有实验完成就不会有下一次唤醒，
		// 那刚把冷却缩到 1 小时就白设了。
		notify(
			`链上所有模型都在冷却中。循环继续跑，先不唤醒 agent。\n${cooldownEta()}\n想立刻恢复就 /login 一个新 provider，再用 /rl models 加进链`,
			"warning",
		);
		return;
	}

	lastWakeAt = Date.now();
	pi.sendUserMessage(resumePrompt(errText), { deliverAs: "followUp" });
}

let cfg: Config = loadConfig();
let timer: ReturnType<typeof setInterval> | undefined;
let watch: RunWatch = loadState();
let pending: PendingItem[] = [];
let escalatedOnce = new Set<string>();
let sshFailCount = 0;
let lastWakeAt = 0;
let lastCtx: ExtensionContext | undefined;
let lastStatus = "尚未轮询";
/** poll 重入保护：ssh 慢的时候上一轮还没回来，下一轮别叠上来 */
let pollInFlight = false;

/**
 * 是否在跑。**以 timer 为唯一真相**，不用单独的 bool 标志。
 *
 * 以前标志在启动流程前半段就置真，后半段（预检 ssh）一旦失败/抛异常，
 * 就留下「标志说在跑、但定时器没建起来」的僵尸状态：
 * 再 /rl start 只会打印状态、什么都不做，必须 /rl stop 才好。
 */
function isRunning(): boolean {
	return timer !== undefined;
}

/** 往待唤醒队列塞一项。同一个 key 不重复塞——
 *  合并窗口内没唤醒时，下一轮轮询会再遇到同一个 run，不去重就会报两遍。 */
function enqueue(item: PendingItem): void {
	if (pending.some((p) => p.key === item.key)) return;
	pending.push(item);
}

function notify(msg: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (lastCtx?.hasUI) lastCtx.ui.notify(msg, level);
	} catch {
		// UI 不可用时忽略
	}
}

/** status 分两行写清楚：上面是扩展自身，下面是实验。别混在一条字符串里。 */
function statusText(): string {
	const lines = [
		`循环：${isRunning() ? "运行中" : "已停止"}（每 ${cfg.pollIntervalSec}s 盯一次实验）`,
		`实验：${lastStatus}`,
	];
	// 全链冷却时循环还在跑但不唤醒，状态栏必须说清楚在等什么，
	// 否则看起来跟「卡死了」一模一样
	const cooling = Object.values(chainState.cooldownUntil).filter((t) => t > Date.now());
	if (cooling.length > 0) {
		const mins = Math.max(1, Math.ceil((Math.min(...cooling) - Date.now()) / 60000));
		lines.push(`模型：${cooling.length} 个在冷却，最早 ${mins} 分钟后恢复`);
	}
	return lines.join("\n");
}

function helpText(): string {
	return [
		"research-loop —— 自主科研迭代循环",
		"",
		"  /rl              开始循环（默认动作）",
		"                  没有实验在跑时会让 agent 开局，不会干等着",
		"  /rl <一句话>      开始循环，并把这句话交给 agent 当第一轮任务",
		"  /rl stop         停止循环",
		"  /rl status       看状态：循环在不在跑 + 实验进展",
		"  /rl goal <文本>   往 goal 的「临时建议」加一条，下一轮 agent 自动读到",
		"                   加 -t <名字> 写到 .auto/goal-<名字>.md",
		"  /rl agents       项目里已有 AGENTS.md 时，让 agent 帮你合并（去重 + 精简）",
		"  /rl models       编辑模型链：额度耗尽时按链的顺序自动切换",
		"  /rl doctor       环境体检（只读）：ssh、目录、脚本、项目文件",
		"  /rl setup        首次一站式：生成项目文件 + 交互式配 ssh（需要 TUI 模式）",
		"  /rl help         显示这个帮助",
		"",
		"首次流程：",
		"  /rl setup  →  回答几个问题，自动配好 ssh",
		"  /reload    →  让新生成的 AGENTS.md 生效",
		"  /rl doctor →  体检，全绿再往下",
		"  /rl        →  开始循环",
		"",
		"跑起来后不用管：有结果 / 崩溃 / 卡死 / 异常，会自动叫醒 agent 继续。",
		"想改方向：改 .auto/goal.md，或 /rl goal <一句话>。",
	].join("\n");
}

function buildWakeMessage(batch: PendingItem[]): string {
	// 只做「叫醒」+ 报状态。每轮具体怎么干写在 AGENTS.md 里，别塞在这儿——
	// 那段内容需要人随时能改，而且它每轮都会进上下文，不该硬编码在扩展里。
	const lines: string[] = ["上一轮的实验有结果了，继续推进。", ""];
	for (const item of batch) lines.push(...item.lines);
	lines.push("");
	lines.push("按 AGENTS.md 的「一轮的流程」继续。");
	return lines.join("\n");
}

/**
 * @returns 是否真的发出去了。调用方**必须**看这个返回值——
 *          发出去才可以把队列里的项标记为已处理，否则结果就静默丢了。
 */
async function wake(pi: ExtensionAPI, text: string, escalationKey?: string): Promise<boolean> {
	// 异常升级只做一次，避免 ssh 长期故障时每轮都烧一次
	if (escalationKey && escalatedOnce.has(escalationKey)) return false;

	// 唤醒前把模型调到链里第一个可用的——顺带完成冷却后的回切
	if (!(await ensureBestModel(pi))) {
		notify(
			`链上所有模型都在冷却中，先不唤醒 agent。\n${cooldownEta()}\n想立刻恢复就 /login 一个新 provider，再用 /rl models 加进链`,
			"warning",
		);
		return false;
	}

	// 成功发出后才记「已升级」：没发出去就不算，下一轮还能再报
	if (escalationKey) escalatedOnce.add(escalationKey);
	lastWakeAt = Date.now();
	lastPrompt = text;
	pi.sendUserMessage(text, { deliverAs: "followUp" });
	return true;
}

async function maybeWake(pi: ExtensionAPI): Promise<void> {
	if (pending.length === 0) return;
	if (Date.now() - lastWakeAt < cfg.mergeWindowSec * 1000) return;

	const batch = pending.splice(0, pending.length);
	// 先发，成功才标记已处理。否则结果会被「已处理」掉却根本没告诉 agent。
	const sent = await wake(pi, buildWakeMessage(batch));
	if (sent) {
		for (const b of batch) {
			// 只有终态（完成 / 崩溃）才永久标记已处理。
			// 超时和卡住都**不是**终态：实验还在跑，标记了就会把之后真正出现的
			// DONE 永久跳过 → 实验静默失联。
			//   超时 → 重新计时（再过一个 maxHours 才提醒）
			//   卡住 → 打节流时间戳（至少隔 stallMinutes 才再提醒）
			if (b.after === "handled") markHandled(watch, b.key);
			else if (b.after === "stall") markStallWarn(watch, b.key);
			else resetSeen(watch, b.key);
		}
	} else {
		// 没发出去：原样放回队首，下一轮再试
		pending.unshift(...batch);
	}
}

/** ssh 出问题（不是"文件不存在"，是连不上/命令跑不了）时统一处理 */
function handleSshFailure(pi: ExtensionAPI, res: { err: string; out: string }): void {
	sshFailCount += 1;
	lastStatus = `ssh 失败 ${sshFailCount}/${cfg.sshFailEscalate}`;
	if (sshFailCount >= cfg.sshFailEscalate) {
		sshFailCount = 0;
		void wake(
			pi,
			[
				`轮询 ssh 连续失败 ${cfg.sshFailEscalate} 次，无法确认实验状态。`,
				`最后错误：${(res.err.trim() || res.out.trim() || "(无输出)").slice(0, 500)}`,
				"",
				`请诊断：ssh ${cfg.sshHost} 是否可用、别名是否配对、服务器是否可达。`,
			].join("\n"),
			"ssh",
		);
	}
}

/**
 * 待检查表里的一行。
 *
 * track / note 是**给 agent 看的自由标签**，扩展只透传、不解析语义——
 * 它不知道你写的是什么，只是把字符串搬进唤醒消息。
 */
interface TableEntry {
	path: string;
	pid?: string;
	track?: string;
	note?: string;
}

/** 按扩展名决定解析方式：.csv 走 CSV，其余走「空白分隔 + 行尾 pid」（向后兼容） */
function isCsvTable(): boolean {
	return /\.csv$/i.test(cfg.runsFile);
}

/** agent 维护的待检查表：过滤空行和 # 注释 */
function readRunsTable(): string[] {
	const file = join(process.cwd(), cfg.runsFile);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
}

/** 唤醒消息里怎么称呼这个 run：有 track/note 就带上，唤醒后一眼知道该读哪个 goal */
function describe(e: TableEntry): string {
	const tag = [e.track, e.note].filter(Boolean).join(" / ");
	return tag ? `${e.path}  [${tag}]` : e.path;
}

/** 最小可用的 CSV 切分：支持双引号包裹和 "" 转义，够用且不引依赖 */
function splitCsv(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c !== '"') cur += c;
			else if (line[i + 1] === '"') {
				cur += '"';
				i++;
			} else quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	out.push(cur);
	return out.map((s) => s.trim());
}

function csvCell(v: string): string {
	return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV 一行：path,pid,track,note —— 后三列都可空 */
function parseCsvLine(line: string): TableEntry {
	const c = splitCsv(line);
	const path = c[0] ?? "";
	if (!path) return { path: "" };
	const pid = /^\d+$/.test(c[1] ?? "") ? c[1] : undefined;
	return { path, pid, track: c[2] || undefined, note: c[3] || undefined };
}

/** 旧格式一行：路径 + 可选 pid（最后一个纯数字 token） */
function parseTxtLine(line: string): TableEntry {
	const parts = line.split(/\s+/);
	// 最后一个 token 是纯数字 → 当成 pid（这样路径里带空格也不会被拆坏）
	if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1] ?? "")) {
		const pid = parts.pop();
		return { path: parts.join(" "), pid };
	}
	return { path: line };
}

function parseTableEntries(): TableEntry[] {
	const lines = readRunsTable();
	const parsed = isCsvTable()
		? lines.filter((l) => !/^path\s*,/i.test(l)).map(parseCsvLine) // 跳过表头
		: lines.map(parseTxtLine);
	return parsed.filter((e) => e.path);
}

type TableState = "DONE" | "RUNNING" | "CRASHED" | "NOPID" | "STALLED" | "UNKNOWN";

/**
 * 一次 ssh 判出状态：
 *   DONE     有 DONE 文件（不管进程还在不在收尾）
 *   RUNNING  没 DONE，进程活着，且输出目录还在产出
 *   STALLED  进程活着（或没 pid），但输出目录**已经 stallMinutes 没有任何文件更新**
 *            ← 这是判断「实验还活着吗」的主要信号
 *   CRASHED  没 DONE 且进程没了 ← pid 的价值就在这，立刻发现
 *   NOPID    没登记 pid（Slurm/Docker），但目录还在产出
 *   UNKNOWN  ssh 本身出问题
 *
 * 为什么用「目录还在不在产出」而不是「跑了多久」：
 * 实验该跑多久完全没法预先知道——5 个 epoch 和 200 个 epoch 差几十倍，
 * 任何固定时长都会对其中一类误报。但「还在产出」对所有实验都成立。
 */
async function remoteRunState(entry: TableEntry): Promise<TableState> {
	const done = shellQuote(`${entry.path}/DONE`);
	const dir = shellQuote(entry.path);
	const n = Math.max(1, Math.round(cfg.stallMinutes));
	const hasPid = entry.pid !== undefined && /^\d+$/.test(entry.pid);
	const alive = hasPid ? "RUNNING" : "NOPID";

	// 目录里有没有 stallMinutes 内更新过的文件
	const probe =
		`if find ${dir} -type f -mmin -${n} -print -quit 2>/dev/null | grep -q .; ` +
		`then echo ${alive}; ` +
		// 有文件但都不新鲜 → 卡住了
		`elif find ${dir} -type f -print -quit 2>/dev/null | grep -q .; ` +
		`then echo STALLED; ` +
		// 一个文件都没有 → 可能刚起还没写出东西，别误判
		`else echo ${alive}; fi`;

	const cmd = hasPid
		? `test -f ${done} && echo DONE || { if kill -0 ${entry.pid} 2>/dev/null; then ${probe}; else echo CRASHED; fi; }`
		: `test -f ${done} && echo DONE || ${probe}`;

	const res = await runRemote(cfg.sshHost, cmd, cfg.sshTimeoutSec);
	const out = res.out.trim();
	const known: TableState[] = ["DONE", "RUNNING", "CRASHED", "NOPID", "STALLED"];
	return known.find((s) => s === out) ?? "UNKNOWN";
}

/**
 * table 模式（默认，迭代用）
 *
 * 只认一个约定：登记的路径下出现 DONE 就算完成。
 * 不假设实验怎么起（nohup / sbatch / docker 都行），
 * 也不要求日志写到哪——兼容性全靠这个。
 */
async function pollTable(pi: ExtensionAPI): Promise<void> {
	const entries = parseTableEntries();
	forget(watch, entries.map((e) => e.path));

	if (entries.length === 0) {
		lastStatus = `${cfg.runsFile} 为空，没有在跑的实验`;
		return;
	}

	let running = 0;
	for (const e of entries) {
		if (watch.handled.includes(e.path)) continue;

		const st = await remoteRunState(e);
		if (st === "UNKNOWN") {
			handleSshFailure(pi, { err: "", out: "" });
			return;
		}
		sshFailCount = 0;

		if (st === "DONE") {
			enqueue({
				key: e.path,
				lines: [`- 完成：${describe(e)}`, `  读 ${e.path}/DONE 看结果。`],
				after: "handled",
			});
			continue;
		}

		// 卡住：输出目录不产出了。比 maxHours 更早也更准——
		// 实验该跑多久没法预知，但「还在产出」对所有实验都成立
		if (st === "STALLED") {
			if (!stallWarnedRecently(watch, e.path, cfg.stallMinutes)) {
				enqueue({
					key: e.path,
					lines: [
						`- 疑似卡住：${describe(e)}`,
						`  输出目录已 ${cfg.stallMinutes} 分钟没有任何文件更新。`,
						`  去查：是真卡住了（死锁 / 等数据 / GPU 挂起），还是这个实验本来就这么久不打日志？`,
						`  如果只是日志间隔长，把配置里的 stallMinutes 调大。`,
					],
					after: "stall",
				});
			}
			running += 1;
			continue;
		}

		if (st === "CRASHED") {
			enqueue({
				key: e.path,
				lines: [
					`- 崩溃：${describe(e)}`,
					`  进程 ${e.pid} 已不存在，且没有 DONE。`,
					`  去读它的日志定位原因，然后把这行从 ${cfg.runsFile} 删掉。`,
				],
				after: "handled",
			});
			continue;
		}

		// RUNNING 或 NOPID：只能靠时间兜底，防「忘了写 DONE」变成永久静默
		const started = touch(watch, e.path);
		const hours = (Date.now() - started) / 3600000;
		if (hours > cfg.maxHours) {
			enqueue({
				key: e.path,
				lines: [
					`- 超时：${describe(e)}`,
					`  登记已 ${Math.round(hours)} 小时，仍没有 DONE。`,
					st === "NOPID"
						? `  没登记 pid，无法判断进程是否还活着。去查：崩了、卡了，还是忘了写 DONE？`
						: `  进程还在但没有 DONE。去查：卡住了，还是训练代码忘了写 DONE？`,
				],
				after: "reset",
			});
			continue;
		}
		running += 1;
	}

	lastStatus = `在跑 ${running}，待处理 ${pending.length}`;
	await maybeWake(pi);
}

async function poll(pi: ExtensionAPI): Promise<void> {
	await pollTable(pi);
}

/**
 * 逐项实测环境，把「首次配置清单」变成自动检查。
 * 只做只读检查，不启动任何东西。
 */
async function doctor(): Promise<void> {
	cfg = loadConfig();
	const lines: string[] = [];
	let problems = 0;

	// 填了但填错的字段：loadConfig 会静默忽略改用默认值，这里明确说出来
	const badKeys = invalidConfigKeys();
	if (badKeys.length > 0) {
		problems += 1;
		lines.push(`✗ 配置里这些字段不是有效数字，已忽略、改用默认值：${badKeys.join(", ")}`);
		lines.push("  填成数字，否则对应行为不是你以为的（比如 stallMinutes 失效 = 卡住检测不工作）");
	}

	const missing: string[] = [];
	if (cfg.sshHost === PLACEHOLDER) missing.push("sshHost");

	if (missing.length > 0) {
		problems += 1;
		lines.push(`✗ 配置未填：${missing.join(", ")}`);
		lines.push(`  跑 /rl setup 补齐，或手动填 <项目>/.pi/research-loop.json`);
	} else {
		lines.push("✓ 配置字段已填");

		const ping = await runRemote(cfg.sshHost, "echo ok", cfg.sshTimeoutSec);
		if (ping.ok && ping.out.trim().startsWith("ok")) {
			lines.push(`✓ ssh 免密连通：${cfg.sshHost}`);
		} else {
			problems += 1;
			lines.push(`✗ ssh 连不通：${cfg.sshHost}`);
			lines.push(`  ${(ping.err.trim() || ping.out.trim() || "无输出").slice(0, 200)}`);
			lines.push("  检查：~/.ssh/config 有这个 Host 吗？配了免密 key 吗？");
		}

		// 登记表在不在、里面有没有路径
		const table = readRunsTable();
		if (table.length === 0) {
			lines.push(`-- ${cfg.runsFile} 不存在或为空（还没登记任何实验，正常）`);
		} else {
			lines.push(`✓ ${cfg.runsFile} 有 ${table.length} 个在跑的实验`);
		}
	}

	// 项目级文件（跟着 cwd）。
	// goal 可能有多份（goal.md 或 goal-<名字>.md），找到任一就算有。
	const autoDir = join(process.cwd(), ".auto");
	const goalFiles = existsSync(autoDir)
		? readdirSync(autoDir).filter((f) => /^goal[A-Za-z0-9_-]*\.md$/i.test(f))
		: [];
	if (goalFiles.length === 0) {
		lines.push(`-- 缺少 .auto/goal.md（跑 /rl setup 会生成）`);
	} else {
		const g = goalStatus();
		if (g.exists && g.missing.length > 0) {
			// 文件在但没填：这比「文件不在」更该报——
			// 扩展会照常开局，而 agent 拿不到方向
			problems += 1;
			lines.push(`✗ .auto/goal.md 还没填：${g.missing.join("、")}`);
			lines.push(`  没填的话 agent 开局没有方向（这种情况下 /rl 会直接拒绝启动）`);
		} else {
			lines.push(
				goalFiles.length === 1
					? `✓ .auto/${goalFiles[0]}`
					: `✓ goal ${goalFiles.length} 份：${goalFiles.map((f) => `.auto/${f}`).join("、")}`,
			);
		}
	}
	for (const f of [".auto/notes.md", "AGENTS.md"]) {
		if (existsSync(join(process.cwd(), f))) {
			lines.push(`✓ ${f}`);
		} else {
			lines.push(`-- 缺少 ${f}（跑 /rl setup 会生成）`);
		}
	}

	lines.push("");
	lines.push(problems > 0 ? `共 ${problems} 项待处理` : "全部就绪，可以 /rl start");

	notify(lines.join("\n"), problems > 0 ? "warning" : "info");
}

const AGENTS_BEGIN = "<!-- BEGIN research-loop -->";
const AGENTS_END = "<!-- END research-loop -->";

/** 没有已有 AGENTS.md 时，背景先留个占位（它归你写，不在规则块里） */
const BACKGROUND_STUB = `# 项目背景

<!-- TODO: 用一两句话写清你在做什么、当前阶段的目标 -->`;

/**
 * 去掉模板里的「## 背景」一节。
 *
 * 背景要放在标记块**外面**：它是从你已有的 AGENTS.md 里提取出来的，
 * 属于你；而标记块里的规则属于上游模板，自动更新时会整块替换——
 * 背景放里面的话，你写的内容会被冲掉。
 */
function stripBackground(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let skipping = false;
	for (const l of lines) {
		if (/^##\s+背景\s*$/.test(l)) {
			skipping = true;
			continue;
		}
		if (skipping && /^##\s+/.test(l)) skipping = false;
		if (!skipping) out.push(l);
	}
	return out.join("\n").trim();
}

/** 规则正文：模板去掉背景 + {{SSH_ALIAS}} 替换成实际别名 */
function rulesBody(tplDir: string): string {
	const src = join(tplDir, "AGENTS.research.md");
	if (!existsSync(src)) return "";
	return stripBackground(readFileSync(src, "utf8").trim()).replace(
		/\{\{SSH_ALIAS\}\}/g,
		cfg.sshHost || SSH_ALIAS,
	);
}

/**
 * AGENTS.md 特殊处理：**不能跳过**。
 *
 * pi 在同一个目录里只加载一份上下文文件（AGENTS.override.md > AGENTS.md > CLAUDE.md），
 * 所以项目里已经有 AGENTS.md 时，再放一个新文件是不会被读的。
 * 而 table 模式完全依赖 agent 遵守规则（写 DONE + 调 track_run），
 * 规则没进去 = 实验永远不会被等 = 静默失败。
 *
 * 三种情况：
 *   没有 AGENTS.md     → 生成（背景占位 + 规则块）
 *   有标记块           → 只替换那一块，背景和其他内容不动
 *   有但没标记块       → **不机械追加**（会和已有内容重复），提示跑 /rl agents 让模型合并
 */
function installAgentsRules(tplDir: string): string {
	const dest = join(process.cwd(), "AGENTS.md");
	const rules = rulesBody(tplDir);
	if (!rules) return `✗ 模板缺失：AGENTS.research.md`;
	const block = `${AGENTS_BEGIN}\n${rules}\n${AGENTS_END}\n`;

	try {
		if (!existsSync(dest)) {
			writeFileSync(dest, `${BACKGROUND_STUB}\n\n${block}`);
			return `✓ 已生成：AGENTS.md（背景待你写 + 规则块）`;
		}
		const cur = readFileSync(dest, "utf8");
		if (cur.includes(AGENTS_BEGIN)) {
			const re = new RegExp(`${AGENTS_BEGIN}[\\s\\S]*?${AGENTS_END}\\n?`);
			writeFileSync(dest, cur.replace(re, block));
			return `✓ 已更新：规则块（你的背景和其余内容未动）`;
		}
		return `-- 已有 AGENTS.md 但没合并过。跑 /rl agents 让 agent 帮你合并（避免重复）`;
	} catch (e) {
		return `✗ 写 AGENTS.md 失败：${e instanceof Error ? e.message : String(e)}`;
	}
}

/** 让模型合并 AGENTS.md 的提示词 */
function mergePrompt(existing: string, rules: string): string {
	return [
		"请帮我合并这个项目的 AGENTS.md。",
		"",
		"背景：我要在这个项目里用 pi-research-loop（自主科研迭代循环驱动器），",
		"它需要把自己的规则写进 AGENTS.md。但项目里已经有一份了，",
		"直接追加会和已有内容重复（背景、服务器连接方式、代码规范等都会出现两遍）。",
		"",
		"下面给你两份内容：`<existing>` 是现有的，`<rules>` 是需要并入的规则。",
		"",
		"请输出合并后的完整 AGENTS.md，遵守这些要求：",
		"",
		"1. **结构**：先是「## 背景」（来自 existing），然后是一个带标记的规则块：",
		"   ```",
		"   ## 背景",
		"   ...",
		"   <!-- BEGIN research-loop -->",
		"   ...rules 全文...",
		"   <!-- END research-loop -->",
		"   ```",
		"",
		"2. **背景**：从 existing 里提取项目背景、目标、环境/连接信息",
		"   （服务器别名、路径、数据集、怎么跑等），**精简成 3~8 行**。",
		"   保留具体事实，不要泛化成套话。existing 没有的话写「（待补充）」。",
		"",
		"3. **规则块**：`<rules>` 的内容**逐字照抄，一个字都不要改**",
		"   （标题层级、代码块、表格、符号都要一致）。这是硬性要求——",
		"   它是上游模板，改了以后就没法自动更新了。",
		"",
		"4. **去重**：existing 里和 rules 重复的内容（「读 goal.md」「更新 notes.md」",
		"   「起实验前查显卡」之类）不要重复出现，以 rules 为准。",
		"",
		"5. **保留独有信息**：existing 里 rules 没有、但有用的内容",
		"   （特有的环境坑、数据集说明、评测脚本位置等），并入背景，",
		"   或者作为「## 项目补充」放在规则块**之后**。",
		"",
		"6. 把结果**写入 AGENTS.md**（覆盖），不要只打印。写完简要说明改了什么。",
		"",
		"<existing>",
		existing,
		"</existing>",
		"",
		"<rules>",
		rules,
		"</rules>",
	].join("\n");
}

/**
 * 把包里 templates/ 的模板生成到当前项目目录，省掉手动拷贝。
 * 其他文件已存在就跳过（不覆盖你的内容）；AGENTS.md 例外，见上。
 */
function ensureProjectFiles(): string[] {
	const tplDir = templatesDir();
	if (!existsSync(tplDir)) return [`✗ 找不到模板目录：${tplDir}`];

	const cwd = process.cwd();
	const targets = [
		{ from: "goal.md", to: join(".auto", "goal.md"), hint: "你写方向" },
		{ from: "notes.md", to: join(".auto", "notes.md"), hint: "当前状态 + 死胡同（每轮重写，精简）" },
		{ from: "tree.md", to: join(".auto", "tree.md"), hint: "完整尝试树（累积，按需读）" },
		{ from: "runs.csv", to: join(".auto", "runs.csv"), hint: "正在跑的实验（agent 增删）" },
		// 注意：不生成 research-loop.json。table 模式零配置就能跑，
		// 想调参的人自己建（字段见 docs/reference.md）。
	];

	const lines: string[] = [installAgentsRules(tplDir)];
	for (const t of targets) {
		const src = join(tplDir, t.from);
		const dest = join(cwd, t.to);
		if (!existsSync(src)) {
			lines.push(`✗ 模板缺失：${t.from}`);
			continue;
		}
		if (existsSync(dest)) {
			lines.push(`-- 已存在，跳过：${t.to}`);
			continue;
		}
		try {
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, readFileSync(src));
			lines.push(`✓ 已生成：${t.to}  (${t.hint})`);
		} catch (e) {
			lines.push(`✗ 写入失败：${t.to} — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return lines;
}

/**
 * goal 文件的路径：给名字就是 `.auto/goal-<名字>.md`，不给就是 `.auto/goal.md`。
 * 名字只允许安全字符，避免写成别的路径。
 */
function goalPath(track: string | undefined): string {
	const name = track && /^[A-Za-z0-9_-]+$/.test(track) ? `goal-${track}.md` : "goal.md";
	return join(process.cwd(), ".auto", name);
}

/**
 * goal 里**必须**填的章节。
 *
 * 少了这两个，agent 开局就没有方向——AGENTS.md 只告诉它「去读 goal」，
 * 如果 goal 还是模板（全是 TODO），它等于什么都没拿到。
 */
const GOAL_REQUIRED = ["我在做什么", "大致方向"];

/** 取某个 `## 章节` 的正文，注释和空行不算内容 */
function sectionBody(md: string, heading: string): string {
	const out: string[] = [];
	let collecting = false;
	for (const l of md.split("\n")) {
		if (/^##\s+/.test(l)) {
			collecting = l.trim().replace(/^#+\s*/, "") === heading;
			continue;
		}
		if (collecting) out.push(l);
	}
	return out
		.join("\n")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
}

/** 默认那份 goal（`goal.md`）填没填。另起的 `goal-<名字>.md` 由你自己维护，这里不查。 */
function goalStatus(): { exists: boolean; missing: string[] } {
	const p = join(process.cwd(), ".auto", "goal.md");
	if (!existsSync(p)) return { exists: false, missing: [] };
	const text = readFileSync(p, "utf8");
	return { exists: true, missing: GOAL_REQUIRED.filter((s) => !sectionBody(text, s)) };
}

/**
 * /rl goal —— 直接往 goal 的「临时建议」里加一条。
 * 省得手动开文件改；下一轮 agent 会自动读到。
 */
function addGoal(text: string, track: string | undefined): string {
	const HEADING = "## 临时建议";
	const p = goalPath(track);

	let cur = "";
	if (existsSync(p)) {
		cur = readFileSync(p, "utf8");
	} else {
		const tpl = join(templatesDir(), "goal.md");
		cur = existsSync(tpl) ? readFileSync(tpl, "utf8") : "# Goal\n";
	}

	const line = `- ${text}`;
	const idx = cur.indexOf(HEADING);
	let out: string;
	if (idx === -1) {
		out = `${cur.replace(/\s+$/, "")}\n\n${HEADING}\n\n${line}\n`;
	} else {
		const restStart = idx + HEADING.length;
		const nextHeading = cur.indexOf("\n## ", restStart);
		const insertAt = nextHeading === -1 ? cur.length : nextHeading;
		out = `${cur.slice(0, insertAt).replace(/\s+$/, "")}\n${line}\n${cur.slice(insertAt)}`;
	}

	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, out);
	const rel = `.auto/${p.split(/[\\/]/).pop()}`;
	return `已写进 ${rel} 的「${HEADING}」：\n  ${line}\n\n下一轮 agent 会自动读到。`;
}

/**
 * 定时器和 agent_settled 都走这里：
 *   - 防重入（ssh 慢时上一轮还没回来，下一轮别叠上来，否则并发 ssh + 重复入队）
 *   - 永不抛（poll 内部出任何错都记进 lastStatus，不能把定时器搞死）
 */
function tick(pi: ExtensionAPI): void {
	if (pollInFlight) return;
	pollInFlight = true;
	void poll(pi)
		.catch((e) => {
			lastStatus = `轮询出错：${e instanceof Error ? e.message : String(e)}`;
		})
		.finally(() => {
			pollInFlight = false;
		});
}

async function startPolling(pi: ExtensionAPI): Promise<void> {
	if (timer) return;

	watch = loadState();
	escalatedOnce = new Set();
	sshFailCount = 0;
	pending = []; // 丢掉上次残留，否则会用陈旧内容唤醒
	failoverTried = 0; // 新开一轮循环，换模型重试的次数重新计数

	// 注意：**启动时不要预标记任何 run 为已报过**。
	// 以前有个 primeHandled() 会把启动那一刻已终态的 run 标为 handled，
	// 结果「实验跑完之后才 /rl start」的那些结果永远不会被报出来——
	// 正是最该报的场景。重启不重复报由 .pi/runs-state.json 的持久化保证，不需要它。
	timer = setInterval(() => tick(pi), cfg.pollIntervalSec * 1000);
	tick(pi);
}

function stopPolling(): void {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
	pending = [];
	pollInFlight = false;
}

/** 已知子命令。不在这个集合里的输入都当成「一句话任务」交给 agent */
const SUBCOMMANDS = new Set([
	"start", "on", "stop", "off", "status", "goal",
	"agents", "doctor", "check", "setup", "models", "help", "-h", "--help", "?",
]);

/**
 * 启动第一轮的话术。
 *
 * 不能省：刚开循环时登记表是空的，而扩展**只会被「实验有结果」触发**——
 * 没有实验就永远没人叫醒 agent，用户按了 /rl 只会看到一片安静，
 * 看起来就像坏了。
 *
 * 这里只讲机制（读哪些文件、最后要起实验并登记），
 * 「调研什么、往哪个方向改」一律交给 goal 和 AGENTS.md——那是人的内容。
 */
const BOOTSTRAP_PROMPT = [
	"循环已启动，但登记表里还没有任何实验，所以这一轮由你开局。",
	"",
	"按 AGENTS.md 的「一轮的流程」和 .auto/goal.md 推进。",
	"",
	"注意：实验是**验证手段**，核心是把方法和代码往前推。",
	"这一轮的重点是调研和改代码，起实验是为了验证这次改得对不对。",
	"起完实验记得用 track_run 登记——不登记就没人等它，也不会有任何报错。",
].join("\n");

/**
 * 去重 + 去空白。
 *
 * 重复项不是 bug——`pickAvailable` 顺序遍历，同一个模型的冷却状态一样，
 * 第二遍必然也被跳过，所以留着不会出错。但会让人误以为「挂了会再试一次」，
 * 而实际不会。让配置的长相和实际行为一致。
 */
function normalizeChain(chain: string[]): string[] {
	return [...new Set(chain.map((s) => s.trim()).filter(Boolean))];
}

/** 模型链存全局配置（`~/.pi/agent/`）——模型可用性取决于这台机器登录了什么 */
function saveModelChain(chain: string[]): void {
	const deduped = normalizeChain(chain);
	const removed = chain.length - deduped.length;
	const p = join(homedir(), ".pi", "agent", CONFIG_NAME);
	let cur: Record<string, unknown> = {};
	try {
		if (existsSync(p)) cur = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
	} catch {
		cur = {};
	}
	cur.modelChain = deduped;
	try {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify(cur, null, 2)}\n`);
		cfg = loadConfig();
		chainState = emptyState(); // 链变了，旧的冷却记录作废
		const lines = [`模型链已存到 ${p}`];
		if (removed > 0) lines.push(`（去掉了 ${removed} 个重复项）`);
		lines.push("", ...deduped.map((k, i) => `  ${i + 1}. ${k}`));
		notify(lines.join("\n"), "info");
	} catch (e) {
		notify(`写配置失败：${e instanceof Error ? e.message : String(e)}`, "error");
	}
}

/**
 * /rl models —— 编辑模型链。
 *
 * 第一屏只有链本身（通常 2–4 项），不铺开全部模型；
 * 按 a / r 才打开候选列表（只含这台机器已登录 provider 的模型）。
 */
async function editModelChain(_pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const list = candidateList();
	if (list.length === 0) {
		notify("这台机器上没有可用模型。先 /login 登录至少一个 provider。", "warning");
		return;
	}

	// 动态引入：TUI 组件万一拿不到，不能把整个扩展拖挂
	let matchesKey: (data: string, key: string) => boolean;
	try {
		const mod = (await import("@earendil-works/pi-tui")) as unknown as {
			matchesKey: (data: string, key: string) => boolean;
		};
		matchesKey = mod.matchesKey;
	} catch {
		notify(
			"TUI 组件不可用，打不开编辑界面。\n请直接改 ~/.pi/agent/research-loop.json 里的 modelChain。",
			"warning",
		);
		return;
	}

	const curKey = currentModelKey();
	const chain: string[] = [...cfg.modelChain];
	if (chain.length === 0 && curKey) chain.push(curKey);

	const allKeys = list.map((c) => keyOf(c));
	const missing = missingEntries(cfg.modelChain, list);
	if (missing.length > 0) {
		notify(`链里有这台机器找不到的模型（多半没登录）：${missing.join("、")}`, "warning");
	}

	type Outcome = { done: true; chain: string[] } | { action: "add" | "replace"; at?: number } | undefined;

	// 加/替换要弹二级选择（异步），handleInput 里等不了，所以用「返回结果 + 外层循环」
	for (;;) {
		const res = await ctx.ui.custom<Outcome>((tui, theme, _kb, done) => {
			let cursor = 0;
			const clamp = () => {
				cursor = Math.max(0, Math.min(cursor, chain.length - 1));
			};
			const move = (delta: number) => {
				const to = cursor + delta;
				if (to < 0 || to >= chain.length) return;
				[chain[cursor], chain[to]] = [chain[to]!, chain[cursor]!];
				cursor = to;
			};
			return {
				render(): string[] {
					const lines: string[] = [];
					lines.push(theme.fg("accent", theme.bold("模型链 —— 越靠前越优先，额度用完就往下切")));
					lines.push(theme.fg("muted", "第 1 个是首选；它限额了用第 2 个，以此类推"));
					lines.push("");
					if (chain.length === 0) {
						lines.push(theme.fg("muted", "  （空）按 a 添加"));
					} else {
						chain.forEach((k, i) => {
							const sel = i === cursor;
							const tag = k === curKey ? "   ← 当前" : "";
							const txt = `${sel ? "→" : " "} ${i + 1}. ${k}${tag}`;
							lines.push(sel ? theme.fg("accent", txt) : theme.fg("text", txt));
						});
					}
					lines.push("");
					lines.push(theme.fg("dim", "↑↓ 选中 · [ ] 调整前后顺序 · a 添加 · r 替换 · d 删除"));
					lines.push(theme.fg("dim", "Enter 保存 · Esc 取消"));
					return lines;
				},
				handleInput(data: string): boolean {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(undefined);
						return true;
					}
					if (matchesKey(data, "return")) {
						done({ done: true, chain: [...chain] });
						return true;
					}
					if (matchesKey(data, "up")) {
						cursor -= 1;
						clamp();
						return true;
					}
					if (matchesKey(data, "down")) {
						cursor += 1;
						clamp();
						return true;
					}
					// 移动用纯字符键：Ctrl/Cmd/Alt + 方向键会被 macOS 系统快捷键
					// （Mission Control、切换 Space）或终端本身截走，根本到不了 TUI。
					if (data === "[") {
						move(-1);
						return true;
					}
					if (data === "]") {
						move(1);
						return true;
					}
					// 能用就用，被系统吃掉也不影响（上面两个已经够用）
					if (matchesKey(data, "ctrl+up")) {
						move(-1);
						return true;
					}
					if (matchesKey(data, "ctrl+down")) {
						move(1);
						return true;
					}
					if (data === "a") {
						done({ action: "add" });
						return true;
					}
					if (data === "r") {
						done({ action: "replace", at: cursor });
						return true;
					}
					if (data === "d") {
						if (chain.length > 0) {
							chain.splice(cursor, 1);
							clamp();
						}
						return true;
					}
					return false;
				},
			};
		});

		if (res === undefined) {
			notify("已取消，模型链没改。", "info");
			return;
		}
		if ("done" in res) {
			saveModelChain(res.chain);
			return;
		}
		// 二级：挑一个模型
		const picked = await ctx.ui.select(res.action === "add" ? "添加模型到链尾" : "替换选中的模型", allKeys);
		if (picked) {
			if (res.action === "add") {
				if (chain.includes(picked)) {
					notify(`${picked} 已经在链里了，跳过。`, "info");
				} else {
					chain.push(picked);
				}
			} else if (res.at !== undefined) {
				chain[res.at] = picked;
			}
		}
	}
}

async function startLoop(pi: ExtensionAPI, task: string | undefined): Promise<void> {
	if (isRunning()) {
		// 已经在跑：不重复建定时器，但你这句话照样交给 agent
		if (task) {
			// 必须看返回值：全链冷却时 wake 会失败，
			// 不检查的话照样说「已交给 agent」，实际根本没发出去
			const sent = await wake(pi, task);
			notify(
				sent
					? "循环已在运行，你这句话已交给 agent。"
					: "循环在运行，但你这句话**没发出去**（见上面的提示）。",
				sent ? "info" : "warning",
			);
		} else {
			notify(`循环已在运行，不用重复启动。\n${statusText()}`, "info");
		}
		return;
	}

	if (!isConfigured(cfg)) {
		notify("配置未完成，先填 sshHost（没配过就跑 /rl setup）", "warning");
		return;
	}

	// 空表开局（既没给一句话任务、也没有在跑的实验）时，goal 没填就不开局。
	// 这时候 agent 拿不到任何方向——AGENTS.md 只让它「去读 goal」，
	// 而 goal 还是模板的话，它等于什么都没拿到，只能瞎试。
	if (!task && parseTableEntries().length === 0) {
		const g = goalStatus();
		if (g.exists && g.missing.length > 0) {
			notify(
				[
					`没启动 —— .auto/goal.md 还没填：${g.missing.join("、")}`,
					"",
					"goal 是 agent 唯一的方向来源。先填这几项：",
					...g.missing.map((s) => `  · ${s}`),
					"",
					"填完再 /rl。想先给一句临时方向也行：/rl goal <一句话>",
				].join("\n"),
				"warning",
			);
			return;
		}
	}

	try {
		await startPolling(pi);
	} catch (e) {
		notify(
			`启动失败：${e instanceof Error ? e.message : String(e)}\n可以直接重试 /rl，或 /rl doctor 查环境`,
			"error",
		);
		return;
	}

	// 用 wake() 而不是直接 sendUserMessage：它才会记 lastWakeAt。
	// 这里不能无条件设 lastWakeAt——那样会把「已有实验结果」的首次唤醒
	// 也一起挡进合并窗口，明明有结果却要等下一轮才报。
	if (task) {
		const sent = await wake(pi, task);
		notify(
			sent
				? `循环已开始 — 你这句话已交给 agent。\n/rl stop 停止`
				: `循环已开始，但你这句话**没发出去**（见上面的提示）。\n解决后重试，或直接打字跟 agent 说`,
			sent ? "info" : "warning",
		);
		return;
	}

	// 没有实验在跑时必须主动开局，否则「等实验」永远等不到东西
	if (parseTableEntries().length === 0) {
		const sent = await wake(pi, BOOTSTRAP_PROMPT);
		notify(
			sent
				? `循环已开始 — 表里没有实验，已让 agent 启动第一轮。\n/rl stop 停止`
				: `循环已开始，但**没能叫醒 agent 开局**（见上面的提示）。`,
			sent ? "info" : "warning",
		);
		return;
	}

	notify(`循环已开始 — 盯着已登记的实验，有结果就叫醒 agent。\n/rl stop 停止`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rl", {
		description: "research-loop：开始循环（默认） / <一句话任务> / stop / status / goal / agents / doctor / setup / help",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			cfg = loadConfig();
			const a = args.trim();

			// 默认动作 = 开始循环。不是子命令的输入都当「一句话任务」，
			// 这样 /rl 帮我先调研有哪些方法可对比 也能直接用。
			const first = a.split(/\s+/)[0] ?? "";
			const isStartCmd = !a || a === "start" || a === "on";
			if (isStartCmd || !SUBCOMMANDS.has(first)) {
				await startLoop(pi, isStartCmd ? undefined : a);
				return;
			}

			if (a === "models") {
				if (ctx.mode !== "tui") {
					notify("/rl models 是交互式界面，需要 TUI 模式（当前不是）", "warning");
					return;
				}
				await editModelChain(pi, ctx);
				return;
			}

			if (a === "help" || a === "-h" || a === "--help" || a === "?") {
				notify(helpText(), "info");
				return;
			}

			if (a === "stop" || a === "off") {
				stopPolling();
				notify("循环已停止", "info");
				return;
			}

			if (a === "status") {
				notify(statusText(), "info");
				return;
			}

			if (a === "goal" || a.startsWith("goal ")) {
				const rest = a.slice("goal".length).trim();
				// /rl goal -t <名字> <文本> —— 写到 .auto/goal-<名字>.md
				// 多数情况用不到；想在一个项目里备好几份目标（比如换阶段）时才用
				let track: string | undefined;
				let text = rest;
				const m = /^-t\s+([A-Za-z0-9_-]+)\s+([\s\S]*)$/.exec(rest);
				if (m) {
					track = m[1];
					text = (m[2] ?? "").trim();
				}
				if (!text) {
					notify(
						[
							"用法：/rl goal <想让 agent 知道的方向或建议>",
							"或：/rl goal -t <名字> <文本>（写到 .auto/goal-<名字>.md）",
						].join("\n"),
						"warning",
					);
					return;
				}
				notify(addGoal(text, track), "info");
				return;
			}

			if (a === "agents") {
				const dest = join(process.cwd(), "AGENTS.md");
				if (!existsSync(dest)) {
					notify(`当前目录没有 AGENTS.md，不需要合并（跑 /rl setup 会生成一份）`, "info");
					return;
				}
				const tplDir = templatesDir();
				const rules = rulesBody(tplDir);
				if (!rules) {
					notify(`找不到规则模板：${join(tplDir, "AGENTS.research.md")}`, "error");
					return;
				}
				// 把合并这件事交给模型：机械追加会和已有内容重复，
				// 而「哪些该保留、哪些该精简」正是模型擅长的
				lastWakeAt = Date.now();
				pi.sendUserMessage(mergePrompt(readFileSync(dest, "utf8"), rules), {
					deliverAs: "followUp",
				});
				notify("已把合并任务交给 agent：它会读现有 AGENTS.md + 规则模板，写出合并后的版本", "info");
				return;
			}

			if (a === "doctor" || a === "check") {
				await doctor();
				return;
			}

			if (a === "setup") {
				if (ctx.mode !== "tui") {
					notify("/rl setup 是交互式向导，需要 TUI 模式（当前不是）", "warning");
					return;
				}
				// 一站式：先生成/补齐项目文件，再配 ssh 和服务器
				const fileLines = ensureProjectFiles();
				const report = await runSetup({
					ask: (title, placeholder) => ctx.ui.input(title, placeholder),
					confirm: (title, message) => ctx.ui.confirm(title, message),
					say: (text) => notify(text, "info"),
					status: (text) => {
						try {
							ctx.ui.setWidget("rl-setup", text ? [text] : undefined, { placement: "aboveEditor" });
						} catch {
							// 没 UI 就算了
						}
					},
				});
				// 无论成功失败都清掉状态行（setup 内部有多个提前 return 的分支）
				try {
					ctx.ui.setWidget("rl-setup", undefined);
				} catch {
					// 忽略
				}
				cfg = loadConfig();
				notify(
					[...fileLines, "", ...report.lines, "", "最后：/reload（AGENTS.md 要重新加载），然后 /rl 开始循环"].join(
						"\n",
					),
					report.needsAttention ? "warning" : "info",
				);
				return;
			}

			notify(`不认识的参数：${a}\n\n${helpText()}`, "warning");
		},
	});

	pi.registerTool({
		name: "track_run",
		label: "Track Run",
		description:
			"登记一个正在跑的实验路径（服务器上的绝对路径），轮询会盯它有没有出现 DONE 文件。起完实验必须调这个，否则没人会等它。",
		promptSnippet: "登记一个正在跑的实验路径，让轮询盯它",
		promptGuidelines: [
			"起完实验必须调 track_run 登记路径，否则扩展不会盯它，实验会静默失联",
			"必须保证实验结束时会在该路径下写 DONE 文件（改训练代码，或命令末尾 touch）",
			`实验处理完把它从 ${cfg.runsFile} 里删掉`,
			"track / note 建议填：唤醒消息会原样带上，你一眼就知道这是在试什么",
		],
		parameters: Type.Object({
			path: Type.String({ description: "服务器上该实验输出目录的绝对路径" }),
			pid: Type.Optional(
				Type.String({
					description:
						"服务器上该实验的进程号。强烈建议填（nohup 起的话就是 echo $! 的值）——填了才能在崩溃时立刻发现，而不是等超时。Slurm/Docker 场景填不了就省略。",
				}),
			),
			track: Type.Optional(
				Type.String({
					description:
						"一个自由标签，用来归类这条实验（比如方法名、数据集、阶段）。扩展**不解析**它的含义，只原样带进唤醒消息。",
				}),
			),
			note: Type.Optional(
				Type.String({
					description: "一句话说明在试什么，例如「methodA / SYSU / seed0」。同样只透传，不解析。",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			cfg = loadConfig();
			const p = params.path.trim();
			if (!p) return { content: [{ type: "text", text: "path 不能为空" }], details: { ok: false } };
			if (!p.startsWith("/")) {
				return {
					content: [{ type: "text", text: `path 必须是服务器上的绝对路径（当前是 ${p}）` }],
					details: { ok: false },
				};
			}
			const rawPid = params.pid?.trim();
			if (rawPid && !/^\d+$/.test(rawPid)) {
				return { content: [{ type: "text", text: `pid 必须是数字（当前是 ${rawPid}）` }], details: { ok: false } };
			}

			const track = params.track?.trim() || undefined;
			const note = params.note?.trim() || undefined;

			const file = join(process.cwd(), cfg.runsFile);
			try {
				mkdirSync(dirname(file), { recursive: true });
				const existing = parseTableEntries();
				if (!existing.some((e) => e.path === p)) {
					let chunk = "";
					if (isCsvTable()) {
						// 文件还不存在就先写表头
						if (!existsSync(file)) chunk += "path,pid,track,note\n";
						chunk +=
							[csvCell(p), rawPid ?? "", csvCell(track ?? ""), csvCell(note ?? "")].join(",") + "\n";
					} else {
						// 旧格式放不下额外列，写成注释行放在 run 行上方（解析时会忽略）
						if (track || note) chunk += `# ${[track, note].filter(Boolean).join(" / ")}\n`;
						chunk += `${rawPid ? `${p}\t${rawPid}` : p}\n`;
					}
					appendFileSync(file, chunk);
				} else {
					return {
						content: [{ type: "text", text: `已在盯：${p}` }],
						details: { ok: true, already: true },
					};
				}
			} catch (e) {
				return {
					content: [{ type: "text", text: `写入 ${cfg.runsFile} 失败：${e instanceof Error ? e.message : String(e)}` }],
					details: { ok: false },
				};
			}

			touch(watch, p);
			return {
				content: [
					{
						type: "text",
						text: rawPid
							? `已登记：${p}（pid ${rawPid}）\n轮询会盯 ${p}/DONE，同时盯进程是否还活着——崩了会立刻通知你。`
							: `已登记：${p}（无 pid）\n轮询会盯 ${p}/DONE，以及输出目录是否还在产出。崩了或卡住大约 ${cfg.stallMinutes} 分钟后才提醒，填 pid 的话能立刻发现。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.on("agent_end", (event, ctx) => {
		lastCtx = ctx;
		void handleAgentEnd(pi, (event as { messages?: unknown[] }).messages ?? []);
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		if (!timer) return;
		// 一轮结束后立刻查一次，避免白等一个间隔
		tick(pi);
	});
}
