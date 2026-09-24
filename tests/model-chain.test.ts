/**
 * model-chain 纯函数测试（node:test，需 Node ≥ 22.6）：
 *   node --test --experimental-strip-types tests/model-chain.test.ts
 * 或 npm test。
 *
 * 锁住的行为都是"改坏了会静默出事"的：错误分类决定换不换模型，
 * 时间解析决定冷却多久——provider 改个措辞就可能失配，靠测试兜住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classify,
	classifyError,
	extractCooldownMinutes,
	isCoolingDown,
	keyOf,
	markCooldown,
	matchesEntry,
	missingEntries,
	pickAvailable,
	emptyState,
	type ChainCandidate,
} from "../lib/model-chain.ts";

const CANDIDATES: ChainCandidate<string>[] = [
	{ provider: "openai-codex", id: "gpt-5.5", name: "GPT", model: "m1" },
	{ provider: "zai", id: "glm-5.3", name: "GLM", model: "m2" },
	{ provider: "deepseek", id: "deepseek-v4-pro", name: "DS", model: "m3" },
];

test("classify：结构化错误码优先于文案", () => {
	assert.equal(classify({ code: "usage_limit_reached", message: "whatever" }), "quota");
	assert.equal(classify({ code: "rate_limit_exceeded", message: "whatever" }), "rate");
	// 码说 quota、文案像 rate → 听码的
	assert.equal(classify({ code: "insufficient_quota", message: "rate limit bla" }), "quota");
	assert.equal(classify({ code: 401, message: "xxx" }), "auth");
});

test("classify：英文文案兜底", () => {
	assert.equal(classifyError("You have hit your ChatGPT usage limit (plus plan)."), "quota");
	assert.equal(classifyError("429 Too Many Requests"), "rate");
	assert.equal(classifyError("401 Authentication Fails, Your api key is invalid"), "auth");
	assert.equal(classifyError("fetch failed: ECONNREFUSED"), "network");
	assert.equal(classifyError(""), "none");
});

test("classify：智谱中文报错要认成 quota（2026-09-19 生产实录）", () => {
	const REAL_ZHIPU =
		"rate limit exceeded: 已达到 5 小时的使用上限。您的限额将在 2026-09-19 15:24:24 重置。[202609191514522cdafa07136e45d9]";
	// 注意文案里同时有英文 rate limit 字样——quota 判定在前，必须赢
	assert.equal(classifyError(REAL_ZHIPU), "quota");
	assert.equal(classifyError("余额不足，请充值"), "quota");
	assert.equal(classifyError("额度耗尽"), "quota");
});

test("extractCooldownMinutes：英文相对时长", () => {
	assert.equal(extractCooldownMinutes("Try again in ~192 min."), 192);
	assert.equal(extractCooldownMinutes("Try again in ~2 hours"), 120);
	assert.equal(extractCooldownMinutes("Try again in ~1 day"), 1440);
});

test("extractCooldownMinutes：中文相对时长", () => {
	assert.equal(extractCooldownMinutes("已达到使用上限，约 30 分钟后重试"), 30);
	assert.equal(extractCooldownMinutes("额度耗尽，5 小时后重置"), 300);
});

test("extractCooldownMinutes：智谱真实绝对时间（注入 now 保证确定性）", () => {
	const REAL = "已达到 5 小时的使用上限。您的限额将在 2026-09-19 15:24:24 重置。";
	const now = new Date(2026, 8, 19, 13, 24, 24).getTime(); // 当天 13:24:24
	assert.equal(extractCooldownMinutes(REAL, now), 120);
	// 完整日期已在过去 → 文案过期，不猜 +24h，返回 undefined 让调用方用默认冷却
	const later = new Date(2026, 8, 19, 16, 0, 0).getTime();
	assert.equal(extractCooldownMinutes(REAL, later), undefined);
	// "当天时刻"格式已过点 → 视为明天（这是唯一做 +24h 推断的场景）
	const TOD_TEXT = "额度耗尽，将于 15:24:24 重置";
	assert.equal(extractCooldownMinutes(TOD_TEXT, new Date(2026, 8, 19, 16, 0, 0).getTime()), 23 * 60 + 25);
});

test("extractCooldownMinutes：无时间信息 / 与限额无关的时间不抓", () => {
	assert.equal(extractCooldownMinutes("已达到使用上限"), undefined);
	assert.equal(extractCooldownMinutes("checkpoint saved at 2026-09-19 15:24:24"), undefined);
	assert.equal(extractCooldownMinutes(""), undefined);
});

test("pickAvailable：按链序取第一个可用的；冷却跳过；全冷却返回 undefined", () => {
	const chain = ["openai-codex/gpt-5.5", "zai/glm-5.3"];
	const st = emptyState();
	const t0 = Date.now();
	assert.equal(pickAvailable(chain, CANDIDATES, st, t0)?.id, "gpt-5.5");
	markCooldown(st, keyOf(CANDIDATES[0]), t0 + 3600_000);
	assert.equal(pickAvailable(chain, CANDIDATES, st, t0)?.id, "glm-5.3");
	markCooldown(st, keyOf(CANDIDATES[1]), t0 + 3600_000);
	assert.equal(pickAvailable(chain, CANDIDATES, st, t0), undefined);
	// 冷却到期 → 自然回切链头（懒探回升）
	assert.equal(pickAvailable(chain, CANDIDATES, st, t0 + 3600_000 + 1)?.id, "gpt-5.5");
});

test("matchesEntry / missingEntries：provider/id、裸 id、name 三种写法都认", () => {
	assert.ok(matchesEntry("openai-codex/gpt-5.5", CANDIDATES[0]));
	assert.ok(matchesEntry("gpt-5.5", CANDIDATES[0]));
	assert.ok(matchesEntry("glm", CANDIDATES[1]));
	assert.ok(!matchesEntry("gpt-5.5", CANDIDATES[1]));
	assert.deepEqual(missingEntries(["openai-codex/gpt-5.5", "kimi/k2"], CANDIDATES), ["kimi/k2"]);
});
