# 内部机制笔记

给继续开发这个扩展的人（或 agent）。记录的是**实测确认过的行为和踩过的坑**，不是猜测。

---

## 1. 扩展是怎么被加载的

```
1. pi 启动，扫描目录
     - <cwd>/.pi/extensions/       （项目级）
     - ~/.pi/agent/extensions/     （全局）
     - settings 显式配置的路径
2. 找到 .ts / .js，用 jiti 运行时加载
3. 每个文件必须 export default function (pi) {...}
   → pi 调用它，把「遥控器」pi 对象递进来
4. 你在函数里注册：registerTool / registerCommand / pi.on
5. 入口函数执行完就结束 —— 但注册的东西留在 pi 里
6. 之后 pi 运行时查表调用
```

**关键认知：不是你连 pi，是 pi 来读你。** 入口函数只在加载时执行一次（登记），登记进去的代码按需反复执行。

所以**模块顶层的 `let` 变量跨调用存活**——这是循环能记住进度的原因。

### 两个坑

**扩展文件只能存在于一个位置。** 同时出现在 `~/.pi/agent/extensions/` 和 `<项目>/.pi/extensions/` 会被加载两次 → 每轮唤醒两次，循环失控。

**库文件不能放 `extensions/`。** pi 会把那里的 `.ts` 全当扩展加载（`loader.ts` 只扫一层，直接文件就加载）。共享代码要放旁边的 `lib/`：

```
├── extensions/     ← pi 扫这里
└── lib/            ← pi 不扫这里
```

## 2. 事件选择（重要）

| 事件 | 语义 | 一次对话触发几次 | 用途 |
|---|---|---|---|
| `agent_end` | agent 一轮跑完，**但 pi 可能还会自动重试/压缩** | 1 | 带 `messages`，检查成功/失败 |
| `agent_settled` | **彻底安定**，pi 不会再有任何自动动作 | 1 | **驱动循环** |
| `turn_start` / `turn_end` | 单个 turn | **2 次** | ⚠️ **绝对不要用来驱动循环** |

**用 `turn_end` 会导致一轮发两条消息，循环失控。**

实测顺序：`agent_end` → `agent_settled`，间隔 1–6 毫秒。

本扩展在 `agent_settled` 里做两件事：立刻轮询一次（不等下一个间隔），以及必要时唤醒下一轮。

## 3. 循环的成本是 N²

**历史由 pi 自动装配，扩展不需要也不应该手动拼历史。**

- 源码：`packages/coding-agent/src/core/session-manager.ts` 的 `buildSessionContext()`
- 流程：从会话树根走到当前叶子 → 收集沿途条目 → 转成消息 → 按当前模型重新编码
- **每轮发送完整历史** → N 轮总成本是 **N²**，不是线性
- 轮数多了触发自动压缩（默认 `keepRecentTokens: 20000`）

**直接后果**：让 LLM 去轮询「跑完了吗」是灾难——每次空轮询都是一次完整的、带全量历史的调用，而且「还没好」这种废话会永久留在历史里，让之后每轮都更贵。这就是本扩展坚持**代码轮询、零 token** 的原因。

## 4. 长实验等待：为什么不能用 sleep

让 agent 在前台等实验跑完会：占着轮次、撑爆上下文、烧钱、不抗重启。

正确架构（本扩展的实现）：

```
1. agent 用 start_run 起实验 → nohup 后台，pid/log 写到文件
2. agent 这一轮立刻结束
3. 扩展用 setInterval + ssh 轮询（纯代码，零 token）
4. 发现跑完/崩溃/卡死 → sendUserMessage 唤醒 agent
5. agent 读结果、决定下一步、再立刻结束 → 回到 1
```

### 一个必须知道的限制

**定时器挂在 pi 进程上，pi 关掉轮询就没了。**

- 实验进程本身（nohup）独立于 pi，安全
- 但「唤醒 agent」需要 pi 活着
- 缓解：状态全在文件里（重启后读文件即可恢复），需要更高可靠性就加系统 cron/systemd 兜底

### 检查不需要智能

PID 存活、日志 mtime、DONE 文件存在性 → 纯代码判断，零成本。
只有「看不懂的报错要不要重试」才需要模型，那种情况交给唤醒后的 agent 处理。

## 5. 崩溃检测是必需的

只看 `DONE` 文件的话，实验第 3 分钟 OOM 挂了 → 永远不会有 `DONE` → 扩展轮询到天荒地老，而且不报错、不通知，最难查。

`run_status.sh` 的三段判据：

```
DONE 存在              → DONE
pid 进程已死           → CRASHED
日志超过 STALL_HOURS 未更新 → STALLED
否则                   → RUNNING
```

`STALLED` 对两天以上的长跑意外地有用（GPU hang、死锁都是这个症状）。

## 6. 防烧钱的两道闸

1. **配置没填完时 `/rl start` 直接拒绝** —— 否则 `statusCommand` 是 `TODO`，每次轮询都会失败并升级唤醒，几分钟烧一轮。
2. **异常升级每次轮询会话只做一次** —— ssh 长期故障时，如果每次失败都唤醒，会变成每 60 秒一次完整 LLM 调用。

## 7. 配置合并：占位值不覆盖

配置查找顺序是「全局 → 项目级」，项目级覆盖全局。

坑：`/rl init` 生成的项目级配置全是 `TODO`，如果直接覆盖，会把全局已填好的值冲掉 —— 而且看不出为什么扩展不启动。

所以 `loadConfig()` 里**跳过值为 `PLACEHOLDER` 的键**，让「只填一部分的项目级配置」是安全的。

## 8. 模型切换（未实现，设计已定）

**不做成独立扩展，做成共享库 `lib/model-chain.ts`。**

理由：库没有自己的生命周期（不会自己启动、自己判断何时干活），只在被调用时做事。做成独立扩展会自己监听 `agent_end`，和任务扩展重复监听 → 一轮换两次模型。

**只用于长任务循环，不做全局自动切换。** 平时聊天手动 `/model`。

### 判断该不该换模型

| 错误类型 | 特征 | 该做什么 |
|---|---|---|
| key 无效 / 鉴权失败 | `401`、`Authentication Fails`、`invalid api key` | **不换模型**，得修配置 |
| 网络问题 | `fetch failed`、`connection`、`timeout` | **重试，不换** |
| 真限额 | `usage limit`、`rate limit`、`quota`、`Try again in ~XX min` | **换模型** |

ChatGPT 那家的限额文案：

```
You have hit your ChatGPT usage limit (plus plan). Try again in ~137 min.
```

pi 从 `usage_limit_reached` / `usage_not_included` / `rate_limit_exceeded` 或 HTTP 429 识别，响应里有 **`resets_at`** 字段（额度恢复时间戳）——**冷却系统应该读这个，不要硬编码 5 小时**。

⚠️ 换机器时 `auth.json` 不同步，排序链里的模型必须都已登录，否则 `setModel` 返回 false，切换链静默失败。

## 9. pi 扩展 API 速查

| 方法 | 作用 |
|---|---|
| `pi.registerTool(tool)` | 注册工具让 agent 调用 |
| `pi.registerCommand(name, { description, handler })` | 注册 `/xxx` 命令 |
| `pi.on(事件, handler)` | 监听事件 |
| `pi.setModel(model)` | 切模型，返回 `Promise<boolean>`（false = 没配鉴权） |
| `pi.sendUserMessage(content, { deliverAs })` | 发用户消息，唤醒一轮 |
| `pi.exec(cmd, args, options)` | 跑 shell 命令 |
| `pi.appendEntry(customType, data)` | 往会话写自定义记录 |
| `ctx.modelRegistry.getAvailable()` / `.find()` / `.complete()` | 模型相关 |
| `ctx.ui.notify(msg, level)` | 弹通知 |
| `ctx.isIdle()` / `ctx.hasUI` | 状态查询 |
| `ctx.abort()` / `ctx.hasPendingMessages()` / `ctx.getContextUsage()` | 控制与查询 |

`deliverAs`：`"followUp"` 排队等 agent 干完再投递（**从定时器里唤醒必须用这个**）；`"steer"` 立即打断。

### 关键源码位置

| 文件 | 内容 |
|---|---|
| `packages/coding-agent/src/core/extensions/types.ts` | 扩展 API 全部类型 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 扩展发现与加载（jiti） |
| `packages/coding-agent/src/core/session-manager.ts` | `buildSessionContext()` 历史装配 |
| `packages/ai/src/api/transform-messages.ts` | 跨模型消息转换 |
| `packages/coding-agent/examples/extensions/` | 官方示例（60+ 个） |

## 10. 开发原则

1. **先具体后抽象。** 没写过一个能跑的扩展就设计库 = 凭空猜接口。共享库等第二个消费者出现再抽。
2. **领域判断归人。** 指标定义、什么算「变好」、哪些方法不值得试——这些写在 `goal.md` 里由人维护，不要硬编码进扩展。
3. **扩展只做机制。** 它不该认识任何领域概念。
