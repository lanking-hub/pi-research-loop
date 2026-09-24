/**
 * model-chain —— 额度耗尽时自动切到链里的下一个模型。
 *
 * 刻意做**共享库**而不是独立扩展：库没有自己的生命周期，只在被调用时做事。
 * 做成扩展会自己监听 agent_end，和主扩展重复，容易一轮里换两次模型。
 *
 * 设计前提（2026-09-24 与用户敲定）：
 *   - 轮询是**零 token** 的，跟模型无关。模型只在「要唤醒 agent」那一刻才重要，
 *     所以切换、冷却检查、冷却后回切全部收敛到 pickAvailable() 一个动作。
 *   - 链是**全局一条**，不按 goal 或 track 分（track 只是标签，不该和模型绑定）。
 *   - 不硬编码任何模型名，也不从可用列表自动排序——自动排序会失控，
 *     「哪些模型有额度、愿意烧钱」只有用户知道。
 *
 * 判据比早期设计更细：pi 自己就把错误分成「不可重试（额度/账单）」和
 * 「可重试（限流/过载）」两类，所以 rate limit 不该换模型——那是每分钟限流，
 * 等一会儿就好，换模型纯属浪费额度。
 */

/** 错误分类。只有 quota 才需要换模型。 */
export type FailoverKind =
	/** 额度/账单耗尽 → 换模型 + 冷却 */
	| "quota"
	/** 限流或过载 → 重试即可，不换（pi 自己会重试） */
	| "rate"
	/** 鉴权失败 → 换模型也没用，得让人修配置 */
	| "auth"
	/** 网络问题 → 重试，不换 */
	| "network"
	/** 认不出来 */
	| "none";

// 顺序有意义：先判 auth（401 也可能带 quota 字样），再判 quota，最后才是限流/网络
const AUTH_PATTERN = /\b401\b|unauthor|authentication fails|invalid[_-]?api[_-]?key|permission denied|forbidden/i;
const QUOTA_PATTERN =
	/usage[_-]?limit|usage_not_included|insufficient_quota|quota exceeded|out of budget|available balance|monthly usage limit|GoUsageLimitError|FreeUsageLimitError|you have hit your .*usage limit|billing|insufficient balance/i;
const RATE_PATTERN = /rate[_-]?limit|too many requests|\b429\b|overloaded|high demand|capacity/i;
const NETWORK_PATTERN = /fetch failed|econnreset|econnrefused|enotfound|socket hang|timed? ?out|network error|dns/i;

/**
 * 从消息里能拿到的错误线索，按可靠度排序。
 *
 * `code` 来自 AssistantMessage.diagnostics[].error.code，是 provider 给的**结构化错误码**
 * （`usage_limit_reached` / `insufficient_quota` / `rate_limit_exceeded`…），
 * 比匹配文案可靠得多——但只有部分 provider 会填，所以其余字段仍要兜底。
 */
export interface ErrorSignal {
	code?: string | number;
	name?: string;
	type?: string;
	message?: string;
}

// 结构化错误码。这是最可信的一层，尽量避免依赖文案。
const QUOTA_CODE =
	/usage_limit_reached|usage_not_included|insufficient_quota|quota_exceeded|out_of_budget|insufficient_balance|billing/i;
const RATE_CODE = /rate_limit|rate_limit_exceeded|too_many_requests|overloaded|^429$/i;
const AUTH_CODE = /unauthorized|authentication_failed|invalid_api_key|permission_denied|forbidden|^401$/i;

/** 推荐入口：把从消息里挖到的线索全给它，它自己按可靠度判断 */
export function classify(sig: ErrorSignal): FailoverKind {
	// 1) 结构化错误码最可信
	const code = sig.code !== undefined ? String(sig.code) : "";
	if (code) {
		if (AUTH_CODE.test(code)) return "auth";
		if (QUOTA_CODE.test(code)) return "quota";
		if (RATE_CODE.test(code)) return "rate";
	}
	// 2) 错误名（如 GoUsageLimitError）
	const name = sig.name ?? "";
	if (name) {
		if (AUTH_PATTERN.test(name)) return "auth";
		if (QUOTA_PATTERN.test(name)) return "quota";
		if (RATE_PATTERN.test(name)) return "rate";
	}
	// 3) 最后才是文案
	const text = [sig.type, sig.message].filter(Boolean).join(" ");
	return classifyError(text);
}

/** 只有文案时的判断。classify() 会兜到这里。 */
export function classifyError(text: string): FailoverKind {
	if (!text) return "none";
	if (AUTH_PATTERN.test(text)) return "auth";
	if (QUOTA_PATTERN.test(text)) return "quota";
	if (RATE_PATTERN.test(text)) return "rate";
	if (NETWORK_PATTERN.test(text)) return "network";
	return "none";
}

/**
 * 从错误文案里抠出「多久之后恢复」。
 *
 * pi 只把 Codex 的 resets_at 转成文案（"Try again in ~192 min."），
 * 结构化时间戳不暴露给扩展；其他 provider 连这句都没有。
 * 抠不到就返回 undefined，调用方用配置的默认值兜底。
 */
export function extractCooldownMinutes(text: string): number | undefined {
	if (!text) return undefined;
	const m = /try again in\s*~?\s*(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i.exec(text);
	if (!m?.[1] || !m[2]) return undefined;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return /^h/i.test(m[2]) ? n * 60 : n;
}

/** 模型在链里的标识 */
export function keyOf(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

export interface ChainCandidate<TModel> {
	provider: string;
	id: string;
	name?: string;
	/** 传给 setModel 的对象；库不关心它是什么 */
	model: TModel;
}

/** 配置里的一项能不能匹配到这个模型。写 provider/id、只写 id、写 name 都认。 */
export function matchesEntry(entry: string, m: { provider: string; id: string; name?: string }): boolean {
	const e = entry.trim().toLowerCase();
	if (!e) return false;
	if (e === keyOf(m).toLowerCase()) return true;
	if (e === m.id.toLowerCase()) return true;
	return m.name ? e === m.name.toLowerCase() : false;
}

/** 冷却记录：模型标识 → 到期毫秒时间戳 */
export interface ChainState {
	cooldownUntil: Record<string, number>;
}

export function emptyState(): ChainState {
	return { cooldownUntil: {} };
}

export function isCoolingDown(state: ChainState, key: string, now: number): boolean {
	return (state.cooldownUntil[key] ?? 0) > now;
}

export function markCooldown(state: ChainState, key: string, until: number): void {
	state.cooldownUntil[key] = until;
}

/**
 * 挑一个能用的模型：按链的顺序，找第一个「候选里有 且 不在冷却中」的。
 *
 * 这一个函数同时实现了两件事：
 *   - 故障切换（当前模型额度用完 → 顺位下一个）
 *   - 冷却后回切（首选恢复了 → 自然回到链头）
 * 所以不需要单独的回切逻辑，也不需要后台定时器。
 */
export function pickAvailable<TModel>(
	chain: readonly string[],
	candidates: readonly ChainCandidate<TModel>[],
	state: ChainState,
	now: number,
): ChainCandidate<TModel> | undefined {
	for (const entry of chain) {
		for (const c of candidates) {
			if (!matchesEntry(entry, c)) continue;
			if (isCoolingDown(state, keyOf(c), now)) continue;
			return c;
		}
	}
	return undefined;
}

/** 链里配置了、但这台机器上找不到（多半是没登录）的项——用来提示用户 */
export function missingEntries<TModel>(
	chain: readonly string[],
	candidates: readonly ChainCandidate<TModel>[],
): string[] {
	return chain.filter((entry) => !candidates.some((c) => matchesEntry(entry, c)));
}
