import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 扩展自己维护的观察状态。
 *
 * 关键分工：
 *   .auto/runs.txt        ← **agent 拥有**（它增删正在跑的实验路径）
 *   .pi/runs-state.json   ← **扩展拥有**（记录每个路径第一次被看到的时间、已报过哪些）
 *
 * 两边不写同一个文件，避免互相覆盖。
 * 时间要落盘是因为：超时兜底（maxHours）必须跨 pi 重启才有效，
 * 否则每次重启计时归零，两天的实验永远等不到超时提醒。
 */

export interface RunWatch {
	/** 路径 → 第一次被看到的毫秒时间戳 */
	firstSeen: Record<string, number>;
	/** 已经报过一轮的路径 */
	handled: string[];
}

const STATE_FILE = ".pi/runs-state.json";

function statePath(): string {
	return join(process.cwd(), STATE_FILE);
}

export function loadState(): RunWatch {
	try {
		const p = statePath();
		if (!existsSync(p)) return { firstSeen: {}, handled: [] };
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<RunWatch>;
		return {
			firstSeen: raw.firstSeen ?? {},
			handled: Array.isArray(raw.handled) ? raw.handled : [],
		};
	} catch {
		return { firstSeen: {}, handled: [] };
	}
}

export function saveState(s: RunWatch): void {
	try {
		mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
		writeFileSync(statePath(), `${JSON.stringify(s, null, 2)}\n`);
	} catch {
		// 存不下就算了，超时兜底会退化成「从本次启动开始计时」
	}
}

/** 取（或初始化）某个路径的首次观察时间 */
export function touch(w: RunWatch, path: string): number {
	const now = Date.now();
	if (w.firstSeen[path] === undefined) {
		w.firstSeen[path] = now;
		saveState(w);
	}
	return w.firstSeen[path];
}

export function markHandled(w: RunWatch, path: string): void {
	w.firstSeen[path] = undefined as unknown as number;
	delete w.firstSeen[path];
	if (!w.handled.includes(path)) w.handled.push(path);
	saveState(w);
}

/** agent 把路径从表里删掉后，扩展这边也忘掉它 */
export function forget(w: RunWatch, livePaths: string[]): void {
	const live = new Set(livePaths);
	let changed = false;
	for (const p of Object.keys(w.firstSeen)) {
		if (!live.has(p)) {
			delete w.firstSeen[p];
			changed = true;
		}
	}
	const before = w.handled.length;
	w.handled = w.handled.filter((p) => live.has(p));
	if (w.handled.length !== before) changed = true;
	if (changed) saveState(w);
}
