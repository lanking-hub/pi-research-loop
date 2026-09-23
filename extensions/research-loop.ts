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
 *   /rl            开始循环（已在跑则显示状态）
 *   /rl stop       停止
 *   /rl status     看状态
 *   /rl goal <文本> 往 goal 的「临时建议」加一条，下一轮自动生效
 *                  （-t <工作流> 写到 .auto/goal-<工作流>.md）
 *   /rl agents     项目里已有 AGENTS.md 时，让 agent 帮你合并（去重 + 精简），
 *                  背景提取自你的文档放在块外，规则块逐字保留
 *   /rl doctor     逐项实测环境，告诉你还差什么（只读体检）
 *   /rl help       显示所有命令的说明
 *   /rl setup      首次一站式：生成项目文件（AGENTS.md / goal / notes / runs.csv）
 *                  + 交互式配 ssh（生成钥匙、写别名、登记指纹）
 *                  唯一人工环节（装公钥）会在向导内暂停等你确认，不用重跑。
 *                  每步幂等，半途失败后重跑是安全的。
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
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isConfigured, loadConfig, PLACEHOLDER, SSH_ALIAS, type Config } from "../lib/config.ts";
import { templatesDir } from "../lib/paths.ts";
import { runRemote } from "../lib/ssh.ts";
import { runSetup } from "../lib/setup.ts";
import { forget, loadState, markHandled, touch, type RunWatch } from "../lib/state.ts";

/** 待唤醒队列里的一项：已经拼好的说明文字 */
interface PendingItem {
	key: string;
	lines: string[];
}

/** 给远程 shell 用的单引号包裹（路径里可能含空格） */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\''`)}'`;
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
	return [
		`循环：${isRunning() ? "运行中" : "已停止"}（每 ${cfg.pollIntervalSec}s 盯一次实验）`,
		`实验：${lastStatus}`,
	].join("\n");
}

function helpText(): string {
	return [
		"research-loop —— 自主科研迭代循环",
		"",
		"  /rl              开始循环（默认动作；已在跑则显示状态）",
		"  /rl stop         停止循环",
		"  /rl status       看状态：循环在不在跑 + 实验进展",
		"  /rl goal <文本>   往 goal 的「临时建议」加一条，下一轮 agent 自动读到",
		"                   加 -t <工作流> 写到 .auto/goal-<工作流>.md",
		"  /rl agents       项目里已有 AGENTS.md 时，让 agent 帮你合并（去重 + 精简）",
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
	lines.push("按 AGENTS.md 的「每一轮怎么工作」继续。");
	return lines.join("\n");
}

function wake(pi: ExtensionAPI, text: string, escalationKey?: string): void {
	if (escalationKey) {
		// 异常升级只做一次，避免 ssh 长期故障时每轮都烧一次
		if (escalatedOnce.has(escalationKey)) return;
		escalatedOnce.add(escalationKey);
	}
	lastWakeAt = Date.now();
	pi.sendUserMessage(text, { deliverAs: "followUp" });
}

function maybeWake(pi: ExtensionAPI): void {
	if (pending.length === 0) return;
	if (Date.now() - lastWakeAt < cfg.mergeWindowSec * 1000) return;
	const batch = pending.splice(0, pending.length);
	for (const b of batch) markHandled(watch, b.key);
	wake(pi, buildWakeMessage(batch));
}

/** ssh 出问题（不是"文件不存在"，是连不上/命令跑不了）时统一处理 */
function handleSshFailure(pi: ExtensionAPI, res: { err: string; out: string }): void {
	sshFailCount += 1;
	lastStatus = `ssh 失败 ${sshFailCount}/${cfg.sshFailEscalate}`;
	if (sshFailCount >= cfg.sshFailEscalate) {
		sshFailCount = 0;
		wake(
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
 * track / note 是**给 agent 看的标签**，扩展只透传、不解析语义——
 * 它不知道 "iter" 和 "baseline" 是什么，只是把字符串搬进唤醒消息。
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

type TableState = "DONE" | "RUNNING" | "CRASHED" | "NOPID" | "UNKNOWN";

/**
 * 一次 ssh 判出三态：
 *   DONE     有 DONE 文件（不管进程还在不在收尾）
 *   RUNNING  没 DONE 但进程活着
 *   CRASHED  没 DONE 且进程没了 ← pid 的价值就在这，立刻发现，不用等超时
 *   NOPID    没登记 pid（Slurm/Docker 场景），只能靠 DONE + 超时
 *   UNKNOWN  ssh 本身出问题
 */
async function remoteRunState(entry: TableEntry): Promise<TableState> {
	const done = shellQuote(`${entry.path}/DONE`);
	const hasPid = entry.pid !== undefined && /^\d+$/.test(entry.pid);
	const cmd = hasPid
		? `test -f ${done} && echo DONE || { kill -0 ${entry.pid} 2>/dev/null && echo RUNNING || echo CRASHED; }`
		: `test -f ${done} && echo DONE || echo NOPID`;
	const res = await runRemote(cfg.sshHost, cmd, cfg.sshTimeoutSec);
	const out = res.out.trim();
	if (out === "DONE" || out === "RUNNING" || out === "CRASHED" || out === "NOPID") return out;
	return "UNKNOWN";
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
			enqueue({ key: e.path, lines: [`- 完成：${describe(e)}`, `  读 ${e.path}/DONE 看结果。`] });
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
			});
			continue;
		}
		running += 1;
	}

	lastStatus = `在跑 ${running}，待处理 ${pending.length}`;
	maybeWake(pi);
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
	// goal 可能按工作流拆成多份（goal-iter.md / goal-baseline.md），找到任一就算有。
	const autoDir = join(process.cwd(), ".auto");
	const goalFiles = existsSync(autoDir)
		? readdirSync(autoDir).filter((f) => /^goal[A-Za-z0-9_-]*\.md$/i.test(f))
		: [];
	if (goalFiles.length > 0) {
		lines.push(
			goalFiles.length === 1
				? `✓ .auto/${goalFiles[0]}`
				: `✓ goal ${goalFiles.length} 份：${goalFiles.map((f) => `.auto/${f}`).join("、")}`,
		);
	} else {
		lines.push(`-- 缺少 .auto/goal.md（跑 /rl setup 会生成）`);
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
 * goal 文件的路径。按工作流拆分时是 `.auto/goal-<track>.md`，
 * 不拆就是 `.auto/goal.md`。track 只允许安全字符，避免写成别的路径。
 */
function goalPath(track: string | undefined): string {
	const name = track && /^[A-Za-z0-9_-]+$/.test(track) ? `goal-${track}.md` : "goal.md";
	return join(process.cwd(), ".auto", name);
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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rl", {
		description: "research-loop：开始循环（默认） / stop / status / goal / agents / doctor / setup / help",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			cfg = loadConfig();
			const a = args.trim();

			// 默认动作 = 开始循环（最常做的那件事）
			if (!a || a === "start" || a === "on") {
				if (isRunning()) {
					notify(`循环已在运行，不用重复启动。\n${statusText()}`, "info");
					return;
				}
				if (!isConfigured(cfg)) {
					notify("配置未完成，先填 sshHost（没配过就跑 /rl setup）", "warning");
					return;
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
				notify(
					`循环已开始 — 我会盯着实验，一有结果就叫醒 agent 继续迭代你的方法。\n/rl stop 停止`,
					"info",
				);
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
				// /rl goal -t <工作流> <文本> —— 写到 .auto/goal-<工作流>.md
				let track: string | undefined;
				let text = rest;
				const m = /^-t\s+([A-Za-z0-9_-]+)\s+([\s\S]*)$/.exec(rest);
				if (m) {
					track = m[1];
					text = (m[2] ?? "").trim();
				}
				if (!text) {
					notify(
						["用法：/rl goal <想让 agent 知道的方向或建议>", "或：/rl goal -t <工作流> <文本>"].join("\n"),
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
			"实验处理完把它从 .auto/runs.csv 里删掉",
			"track / note 强烈建议填：唤醒消息会原样带上，你一眼就知道这是哪个工作流、在试什么",
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
						"这条属于哪个工作流，例如 iter / baseline。扩展**不解析**它的含义，只原样带进唤醒消息。",
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
							: `已登记：${p}（无 pid）\n轮询只盯 ${p}/DONE。崩了要等到 ${cfg.maxHours} 小时超时才会提醒，建议以后能填 pid 就填。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		if (!timer) return;
		// 一轮结束后立刻查一次，避免白等一个间隔
		tick(pi);
	});
}
