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
 *   /rl goal <文本> 往 .auto/goal.md 的「临时建议」加一条，下一轮自动生效
 *   /rl agents     项目里已有 AGENTS.md 时，让 agent 帮你合并（去重 + 精简），
 *                  背景提取自你的文档放在块外，规则块逐字保留
 *   /rl doctor     逐项实测环境，告诉你还差什么（只读体检）
 *   /rl setup      首次一站式：生成项目文件（AGENTS.md / goal / notes / runs.txt）
 *                  + 交互式配 ssh（生成钥匙、写别名、登记指纹、传脚本、写配置）
 *                  唯一人工环节（装公钥）会在向导内暂停等你确认，不用重跑。
 *                  每步幂等，半途失败后重跑是安全的。
 *
 * 配置：**可选**。table 模式零配置就能跑（ssh 别名是固定常量，`/rl setup` 自动写进
 *       ~/.ssh/config）。想调参才建 `<项目>/.pi/research-loop.json`，字段见 docs/reference.md。
 *
 * 依赖：server/run_status.sh（状态）、server/run_exp.sh（起实验）部署到服务器上。
 *
 * 注意：这个文件只能存在于一个位置。如果它同时出现在
 *   ~/.pi/agent/extensions/  和  <项目>/.pi/extensions/
 * 会被 pi 加载两次，导致重复唤醒。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isConfigured, loadConfig, PLACEHOLDER, SSH_ALIAS, type Config } from "../lib/config.ts";
import { templatesDir } from "../lib/paths.ts";
import { expandRemotePath, remoteHome, runRemote } from "../lib/ssh.ts";
import { runSetup } from "../lib/setup.ts";
import { forget, loadState, markHandled, touch, type RunWatch } from "../lib/state.ts";

type RunState = "RUNNING" | "DONE" | "CRASHED" | "STALLED" | "UNKNOWN";

interface RunStatus {
	id: string;
	state: RunState;
}

/** 待唤醒队列里的一项：已经拼好的说明文字（两种模式各自生成） */
interface PendingItem {
	key: string;
	lines: string[];
}

/** 给远程 shell 用的单引号包裹（路径里可能含空格） */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\''`)}'`;
}

/** 解析状态脚本输出：每行 "<runId> <STATE>" */
function parseStatus(out: string): RunStatus[] {
	const runs: RunStatus[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(line);
		if (!m?.[1] || !m[2]) continue;
		const raw = m[2].toUpperCase();
		const state: RunState =
			raw === "RUNNING"
				? "RUNNING"
				: raw === "DONE"
					? "DONE"
					: raw === "CRASHED"
						? "CRASHED"
						: raw === "STALLED"
							? "STALLED"
							: "UNKNOWN";
		runs.push({ id: m[1], state });
	}
	return runs;
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

/** 待检查表里的一行：路径 + 可选的服务器进程号 */
interface TableEntry {
	path: string;
	pid?: string;
}

/** agent 维护的待检查表：一行一个服务器绝对路径，空格/Tab 后可跟 pid */
function readRunsTable(): string[] {
	const file = join(process.cwd(), cfg.runsFile);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
}

function parseTableEntries(): TableEntry[] {
	return readRunsTable().map((line) => {
		const parts = line.split(/\s+/);
		// 最后一个 token 是纯数字 → 当成 pid（这样路径里带空格也不会被拆坏）
		if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1] ?? "")) {
			const pid = parts.pop();
			return { path: parts.join(" "), pid };
		}
		return { path: line };
	});
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
			enqueue({ key: e.path, lines: [`- 完成：${e.path}`, `  读 ${e.path}/DONE 看结果。`] });
			continue;
		}

		if (st === "CRASHED") {
			enqueue({
				key: e.path,
				lines: [
					`- 崩溃：${e.path}`,
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
					`- 超时：${e.path}`,
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

/** dir 模式：固定 runs 目录 + 服务器脚本（baseline 那种死流程用） */
async function pollDir(pi: ExtensionAPI): Promise<void> {
	const res = await runRemote(cfg.sshHost, cfg.statusCommand, cfg.sshTimeoutSec);
	if (!res.ok) {
		handleSshFailure(pi, res);
		return;
	}
	sshFailCount = 0;

	const runs = parseStatus(res.out);
	if (runs.length === 0) {
		lastStatus = "statusCommand 无有效输出";
		wake(
			pi,
			[
				"轮询命令有返回但解析不出任何 run。原始输出：",
				(res.out.trim() || "(空)").slice(0, 500),
				"",
				'期望格式：每行 "<runId> <STATE>"，STATE ∈ RUNNING|DONE|CRASHED|STALLED。',
			].join("\n"),
			"parse",
		);
		return;
	}

	for (const r of runs) {
		if (r.state === "RUNNING" || watch.handled.includes(r.id)) continue;
		const dir = `${cfg.runsPath}/${r.id}`;
		const text =
			r.state === "DONE"
				? [`- ${r.id}：完成。读 ${dir}/DONE 和 ${dir}/log.txt 看结果。`]
				: r.state === "CRASHED"
					? [`- ${r.id}：崩溃。读 ${dir}/log.txt 定位报错。`]
					: r.state === "STALLED"
						? [`- ${r.id}：疑似卡死（日志长时间未更新）。检查后决定杀掉还是继续等。`]
						: [`- ${r.id}：状态未知。请自行 ssh 到 ${cfg.sshHost} 检查 ${dir}。`];
		enqueue({ key: r.id, lines: text });
	}

	const running = runs.filter((r) => r.state === "RUNNING").length;
	lastStatus = `运行中 ${running}，待处理 ${pending.length}`;

	if (running === 0 && pending.length === 0) {
		stopPolling();
		lastStatus = "没有运行中的 run，轮询已停止";
		notify(lastStatus, "info");
		return;
	}

	maybeWake(pi);
}

async function poll(pi: ExtensionAPI): Promise<void> {
	if (cfg.mode === "dir") await pollDir(pi);
	else await pollTable(pi);
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
	// dir 模式才需要固定目录和状态脚本；table 模式只要能连上服务器
	if (cfg.mode === "dir") {
		if (cfg.runsPath === PLACEHOLDER) missing.push("runsPath");
		if (cfg.statusCommand === PLACEHOLDER) missing.push("statusCommand");
	}

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

		if (cfg.mode === "dir") {
			// ~/ 在带引号的命令里不会被 shell 展开，先自己展开再查
			const home = await remoteHome(cfg.sshHost, cfg.sshTimeoutSec);
			const runsAbs = expandRemotePath(cfg.runsPath, home);
			const dir = await runRemote(
				cfg.sshHost,
				`test -d ${JSON.stringify(runsAbs)} && echo yes || echo no`,
				cfg.sshTimeoutSec,
			);
			if (dir.out.trim() === "yes") {
				lines.push(`✓ runs 目录存在：${runsAbs}`);
			} else {
				problems += 1;
				lines.push(`✗ runs 目录不存在：${runsAbs}`);
				lines.push(`  服务器上先 mkdir -p ${runsAbs}`);
				lines.push(`  （配置里写的是 ${cfg.runsPath}；带引号时 ~ 不会展开，建议直接写绝对路径）`);
			}

			const st = await runRemote(cfg.sshHost, cfg.statusCommand, cfg.sshTimeoutSec);
			if (!st.ok) {
				problems += 1;
				lines.push("✗ statusCommand 执行失败");
				lines.push(`  ${(st.err.trim() || st.out.trim() || "无输出").slice(0, 200)}`);
				lines.push("  检查：脚本传上去了吗？chmod +x 了吗？RUNS_DIR 对吗？");
			} else if (parseStatus(st.out).length === 0) {
				lines.push("-- statusCommand 能跑，但还没有任何 run（没跑过实验时正常）");
			} else {
				lines.push(`✓ statusCommand 正常，${parseStatus(st.out).length} 个 run`);
			}
		} else {
			// table 模式：看登记表在不在、里面有没有路径
			const table = readRunsTable();
			if (table.length === 0) {
				lines.push(`-- ${cfg.runsFile} 不存在或为空（还没登记任何实验，正常）`);
			} else {
				lines.push(`✓ ${cfg.runsFile} 有 ${table.length} 个在跑的实验`);
			}
		}

	}

	// 项目级文件（跟着 cwd）
	for (const f of [".auto/goal.md", ".auto/notes.md", "AGENTS.md"]) {
		if (existsSync(join(process.cwd(), f))) {
			lines.push(`✓ ${f}`);
		} else {
			lines.push(`-- 缺少 ${f}（从包里 templates/ 拷到项目根目录）`);
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
		{ from: "runs.txt", to: join(".auto", "runs.txt"), hint: "正在跑的实验（agent 增删）" },
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
 * /rl goal —— 直接往 .auto/goal.md 的「临时建议」里加一条。
 * 省得手动开文件改；下一轮 agent 会自动读到。
 */
function addGoal(text: string): string {
	const HEADING = "## 临时建议";
	const p = join(process.cwd(), ".auto", "goal.md");

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
	return `已写进 .auto/goal.md 的「${HEADING}」：\n  ${line}\n\n下一轮 agent 会自动读到。`;
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
		description: "research-loop：开始循环（默认） / stop / status / goal / agents / doctor / setup",
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
					notify(
						cfg.mode === "dir"
							? "配置未完成，先填 sshHost / runsPath / statusCommand"
							: "配置未完成，先填 sshHost（没配过就跑 /rl setup）",
						"warning",
					);
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
				const text = a.slice("goal".length).trim();
				if (!text) {
					notify("用法：/rl goal <想让 agent 知道的方向或建议>", "warning");
					return;
				}
				notify(addGoal(text), "info");
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

			notify(
				"用法：/rl（开始循环） | /rl stop | /rl status | /rl goal <文本> | /rl agents | /rl doctor | /rl setup",
				"warning",
			);
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
			"实验处理完把它从 .auto/runs.txt 里删掉",
		],
		parameters: Type.Object({
			path: Type.String({ description: "服务器上该实验输出目录的绝对路径" }),
			pid: Type.Optional(
				Type.String({
					description:
						"服务器上该实验的进程号。强烈建议填（nohup 起的话就是 echo $! 的值）——填了才能在崩溃时立刻发现，而不是等超时。Slurm/Docker 场景填不了就省略。",
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

			const line = rawPid ? `${p}\t${rawPid}` : p;
			const file = join(process.cwd(), cfg.runsFile);
			try {
				mkdirSync(dirname(file), { recursive: true });
				const existing = parseTableEntries();
				if (!existing.some((e) => e.path === p)) {
					appendFileSync(file, `${line}\n`);
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

	pi.registerTool({
		name: "start_run",
		label: "Start Run",
		description:
			"在远程服务器上起一个实验 run。**起实验必须走这个工具**，不要直接 ssh nohup，否则 run 不在管理内，永远不会被轮询到。",
		promptSnippet: "在远程服务器上起一个受管理的实验 run",
		promptGuidelines: [
			"起实验前先 ssh 查显卡占用（gpustat / nvidia-smi），把空闲的卡号传给 start_run 的 gpu 参数",
			"不要用 ssh + nohup 直接起实验，必须走 start_run",
			"连服务器一律走 ~/.ssh/config 里配置好的别名（原生 ssh），禁止 wsl ssh / 裸 IP",
		],
		parameters: Type.Object({
			gpu: Type.String({ description: 'CUDA_VISIBLE_DEVICES，例如 "0" 或 "0,1"' }),
			cmd: Type.String({ description: "在服务器上项目根目录执行的命令，例如 python train.py --cfg a.yaml" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			cfg = loadConfig();
			if (cfg.sshHost === PLACEHOLDER || cfg.startCommand === PLACEHOLDER) {
				return {
					content: [{ type: "text", text: "start_run 未配置：请先填 sshHost 和 startCommand" }],
					details: { ok: false },
				};
			}
			// gpu 拼进单引号里，先卡住格式，免得 agent 传进来的内容把命令结构撑坏
			const gpu = params.gpu.trim();
			if (!/^[\d,\s]+$/.test(gpu)) {
				return {
					content: [{ type: "text", text: `gpu 只能是数字和逗号（当前是「${gpu}」）` }],
					details: { ok: false },
				};
			}
			// 命令用 base64 传递，绕开所有 shell 引号问题
			const b64 = Buffer.from(params.cmd, "utf8").toString("base64");
			const remote = `${cfg.startCommand} --gpu '${gpu}' --cmd-b64 '${b64}'`;
			const res = await runRemote(cfg.sshHost, remote, cfg.sshTimeoutSec);
			const text = res.ok
				? `已起 run：${res.out.trim() || "(无输出)"}`
				: `起实验失败：${res.err.trim() || res.out.trim() || "(无输出)"}`;
			return { content: [{ type: "text", text }], details: { ok: res.ok } };
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		if (!timer) return;
		// 一轮结束后立刻查一次，避免白等一个间隔
		tick(pi);
	});
}
