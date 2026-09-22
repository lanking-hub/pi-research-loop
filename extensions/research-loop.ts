/**
 * research-loop — 自主科研迭代循环的驱动器
 *
 * 只做两件事：
 *   1. 定时通过 ssh 轮询远程服务器上各个实验 run 的状态
 *   2. 有结果（完成 / 崩溃 / 卡死 / 未知）时唤醒 agent
 *
 * 它刻意不判定任何事：不认识指标、不做 keep/discard、不决定下一步做什么。
 * 领域规则全部在 AGENTS.md（见 templates/）里，由人维护。
 *
 * 命令：
 *   /rl status   查看状态
 *   /rl start    启动轮询
 *   /rl stop     停止轮询
 *   /rl poll     立刻轮询一次
 *   /rl doctor   逐项实测环境，告诉你还差什么（首次配置时用这个）
 *
 * 配置：~/.pi/agent/research-loop.json（全局）或 <项目>/.pi/research-loop.json（项目级）
 *
 * 依赖：server/run_status.sh（状态）、server/run_exp.sh（起实验）部署到服务器上。
 *
 * 注意：这个文件只能存在于一个位置。如果它同时出现在
 *   ~/.pi/agent/extensions/  和  <项目>/.pi/extensions/
 * 会被 pi 加载两次，导致重复唤醒。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isConfigured, loadConfig, PLACEHOLDER, type Config } from "../lib/config.ts";
import { runSsh } from "../lib/ssh.ts";

type RunState = "RUNNING" | "DONE" | "CRASHED" | "STALLED" | "UNKNOWN";

interface RunStatus {
	id: string;
	state: RunState;
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
let polling = false;
let pending: RunStatus[] = [];
let handled = new Set<string>();
let escalatedOnce = new Set<string>();
let sshFailCount = 0;
let lastWakeAt = 0;
let lastCtx: ExtensionContext | undefined;
let lastStatus = "尚未轮询";

function notify(msg: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (lastCtx?.hasUI) lastCtx.ui.notify(msg, level);
	} catch {
		// UI 不可用时忽略
	}
}

function buildWakeMessage(batch: RunStatus[]): string {
	const lines: string[] = ["有实验 run 状态变化，请处理。", ""];
	for (const r of batch) {
		const dir = `${cfg.runsPath}/${r.id}`;
		if (r.state === "DONE") {
			lines.push(`- ${r.id}：完成。读 ${dir}/DONE 和 ${dir}/log.txt 看结果。`);
		} else if (r.state === "CRASHED") {
			lines.push(`- ${r.id}：崩溃。读 ${dir}/log.txt 定位报错。`);
		} else if (r.state === "STALLED") {
			lines.push(`- ${r.id}：疑似卡死（日志长时间未更新）。检查后决定杀掉还是继续等。`);
		} else {
			lines.push(`- ${r.id}：状态未知。请自行 ssh 到 ${cfg.sshHost} 检查 ${dir}。`);
		}
	}
	lines.push("");
	lines.push("然后：");
	lines.push("1. 按 AGENTS.md 更新 .auto/notes.md（每轮重写，含死胡同）");
	lines.push("2. 用 gpu_status 查实时空闲卡，按 .auto/goal.md 决定下一步");
	lines.push("3. 起新的实验（并发上限与卡占用规则见 .auto/goal.md）");
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
	for (const b of batch) handled.add(b.id);
	wake(pi, buildWakeMessage(batch));
}

async function poll(pi: ExtensionAPI): Promise<void> {
	const res = await runSsh(cfg.sshHost, cfg.statusCommand, cfg.sshTimeoutSec);

	if (!res.ok) {
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
					`请诊断：ssh ${cfg.sshHost} 是否可用、${cfg.statusCommand} 是否存在且有执行权限、${cfg.runsPath} 是否正确。`,
				].join("\n"),
				"ssh",
			);
		}
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
				`请检查服务器上的 ${cfg.statusCommand}。`,
			].join("\n"),
			"parse",
		);
		return;
	}

	for (const r of runs) {
		if (r.state !== "RUNNING" && !handled.has(r.id)) pending.push(r);
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
	if (cfg.runsPath === PLACEHOLDER) missing.push("runsPath");
	if (cfg.statusCommand === PLACEHOLDER) missing.push("statusCommand");
	if (cfg.startCommand === PLACEHOLDER) missing.push("startCommand");

	if (missing.length > 0) {
		problems += 1;
		lines.push(`✗ 配置未填：${missing.join(", ")}`);
		lines.push(`  填 ~/.pi/agent/research-loop.json 或 <项目>/.pi/research-loop.json`);
	} else {
		lines.push("✓ 配置字段已填");

		const ping = await runSsh(cfg.sshHost, "echo ok", cfg.sshTimeoutSec);
		if (ping.ok && ping.out.trim().startsWith("ok")) {
			lines.push(`✓ ssh 免密连通：${cfg.sshHost}`);
		} else {
			problems += 1;
			lines.push(`✗ ssh 连不通：${cfg.sshHost}`);
			lines.push(`  ${(ping.err.trim() || ping.out.trim() || "无输出").slice(0, 200)}`);
			lines.push("  检查：~/.ssh/config 有这个 Host 吗？配了免密 key 吗？");
		}

		const dir = await runSsh(
			cfg.sshHost,
			`test -d ${JSON.stringify(cfg.runsPath)} && echo yes || echo no`,
			cfg.sshTimeoutSec,
		);
		if (dir.out.trim() === "yes") {
			lines.push(`✓ runs 目录存在：${cfg.runsPath}`);
		} else {
			problems += 1;
			lines.push(`✗ runs 目录不存在：${cfg.runsPath}`);
			lines.push(`  服务器上先 mkdir -p ${cfg.runsPath}`);
		}

		const st = await runSsh(cfg.sshHost, cfg.statusCommand, cfg.sshTimeoutSec);
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

		const gpu = await runSsh(cfg.sshHost, cfg.gpuCommand, cfg.sshTimeoutSec);
		if (gpu.ok && gpu.out.trim()) {
			lines.push("✓ gpuCommand 可跑");
		} else {
			problems += 1;
			lines.push("✗ gpuCommand 跑不了，换一个（服务器没装 gpustat 的话用 nvidia-smi）");
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

function startPolling(pi: ExtensionAPI): void {
	if (polling) return;
	polling = true;
	handled = new Set();
	escalatedOnce = new Set();
	sshFailCount = 0;
	timer = setInterval(() => void poll(pi), cfg.pollIntervalSec * 1000);
	void poll(pi);
}

function stopPolling(): void {
	polling = false;
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rl", {
		description: "research-loop: status / start / stop / poll / doctor",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			cfg = loadConfig();
			const a = args.trim();

			if (!a || a === "status") {
				notify(`${polling ? "轮询中" : "已停止"} — ${lastStatus}（间隔 ${cfg.pollIntervalSec}s）`, "info");
				return;
			}

			if (a === "stop" || a === "off") {
				stopPolling();
				notify("research-loop 已停止", "info");
				return;
			}

			if (a === "start") {
				if (!isConfigured(cfg)) {
					notify("配置未完成，先填 sshHost / runsPath / statusCommand", "warning");
					return;
				}
				startPolling(pi);
				notify("research-loop 已启动", "info");
				return;
			}

			if (a === "poll") {
				if (!isConfigured(cfg)) {
					notify("配置未完成", "warning");
					return;
				}
				await poll(pi);
				notify(lastStatus, "info");
				return;
			}

			if (a === "doctor" || a === "check") {
				await doctor();
				return;
			}

			notify("用法：/rl [status|start|stop|poll|doctor]", "warning");
		},
	});

	pi.registerTool({
		name: "gpu_status",
		label: "GPU Status",
		description: "查询远程 GPU 服务器的显卡占用情况。起实验前必须先查，选空闲卡。",
		promptSnippet: "查询远程服务器 GPU 占用",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			cfg = loadConfig();
			if (cfg.sshHost === PLACEHOLDER) {
				return {
					content: [{ type: "text", text: "gpu_status 未配置：请先填 sshHost" }],
					details: { ok: false },
				};
			}
			const res = await runSsh(cfg.sshHost, cfg.gpuCommand, cfg.sshTimeoutSec);
			const text = res.ok
				? res.out.trim() || "(空输出)"
				: `ssh 失败：${res.err.trim() || res.out.trim() || "(无输出)"}`;
			return { content: [{ type: "text", text }], details: { ok: res.ok } };
		},
	});

	pi.registerTool({
		name: "start_run",
		label: "Start Run",
		description:
			"在远程服务器上起一个实验 run。**起实验必须走这个工具**，不要直接 ssh nohup，否则 run 不在管理内，永远不会被轮询到。",
		promptSnippet: "在远程服务器上起一个受管理的实验 run",
		promptGuidelines: [
			"起实验前先用 gpu_status 查空闲卡，把空闲的卡号传给 start_run 的 gpu 参数",
			"不要用 ssh + nohup 直接起实验，必须走 start_run",
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
			// 命令用 base64 传递，绕开所有 shell 引号问题
			const b64 = Buffer.from(params.cmd, "utf8").toString("base64");
			const remote = `${cfg.startCommand} --gpu '${params.gpu}' --cmd-b64 '${b64}'`;
			const res = await runSsh(cfg.sshHost, remote, cfg.sshTimeoutSec);
			const text = res.ok
				? `已起 run：${res.out.trim() || "(无输出)"}`
				: `起实验失败：${res.err.trim() || res.out.trim() || "(无输出)"}`;
			return { content: [{ type: "text", text }], details: { ok: res.ok } };
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		if (!polling) return;
		// 一轮结束后立刻查一次，避免白等一个间隔
		void poll(pi);
	});
}
