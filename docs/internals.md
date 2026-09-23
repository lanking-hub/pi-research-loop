# 内部机制笔记

给继续开发这个扩展的人（或 agent）。记录的是**实测确认过**的行为和踩过的坑，不是猜测。

扩展只有一个模式：agent 在登记表里写实验路径，扩展只查 `DONE` + pid。
（曾经还有个 dir 模式——固定 runs 目录 + 服务器脚本，已删除：它假设"单机 nohup + bash"，
Slurm / Docker 下不成立，而登记表的做法本来就覆盖了它的全部场景。）

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

**库文件不能放 `extensions/`。** pi 会把那里的 `.ts` 全当扩展加载。共享代码放旁边的 `lib/`。

---

## 2. 事件选择（重要）

| 事件 | 语义 | 一次对话触发几次 | 用途 |
|---|---|---|---|
| `agent_end` | agent 一轮跑完，**但 pi 可能还会自动重试/压缩** | 1 | 带 `messages`，检查成功/失败 |
| `agent_settled` | **彻底安定**，pi 不会再有任何自动动作 | 1 | **驱动循环** |
| `turn_start` / `turn_end` | 单个 turn | **2 次** | ⚠️ **绝对不要用来驱动循环** |

**用 `turn_end` 会导致一轮发两条消息，循环失控。**

本扩展在 `agent_settled` 里立刻轮询一次（不等下一个间隔）。

---

## 3. 循环的成本是 N²

**历史由 pi 自动装配，扩展不需要也不应该手动拼历史。**

- 源码：`packages/coding-agent/src/core/session-manager.ts` 的 `buildSessionContext()`
- **每轮发送完整历史** → N 轮总成本是 **N²**，不是线性

**这条决定了整个设计的形状**：长实验的等待**绝不能交给 agent**。

一次「跑完了吗」= 一次完整 LLM 调用带全量历史。两天实验、一小时一查 ≈ 几十次空轮询，后期单次几十万 token，**光等就能烧掉几百万 token**。

所以轮询必须是纯代码：一次 ssh，零 token。这是扩展存在的唯一理由。

---

## 4. 长实验等待：为什么不能用 sleep

让 agent 在前台等实验跑完会：占着轮次、撑爆上下文、烧钱、pi 一关就没了。

的做法：

```
1. agent 自己起实验（nohup / sbatch / docker / conda 随意），拿进程号
2. agent 调 track_run 登记：路径 + 进程号
3. agent 这一轮结束
4. 扩展每 60 秒 ssh 问一次：DONE 在吗？进程还活着吗？
5. 有结果 → sendUserMessage 唤醒 agent
6. agent 看结果、改方法/代码、起下一个 → 回到 1
```

### 一个必须知道的限制

**定时器挂在 pi 进程上，pi 关掉轮询就没了。**

- 实验进程本身独立于 pi，安全
- 但「唤醒 agent」需要 pi 活着
- 缓解：状态全在文件里，重启后读文件恢复

---

## 5. 唯一约定

**扩展只认一件事**：登记的路径下出现 `DONE` 文件。

怎么起实验完全不管——`nohup`、`sbatch`、`docker run`、`conda run` 都行。
**兼容性来自"不管你怎么起"**，这也是它能覆盖 Slurm / Docker / 多机 / conda 各种环境的原因。

判断用**一条 ssh**：

```bash
test -f '<路径>/DONE' && echo DONE || { kill -0 <pid> 2>/dev/null && echo RUNNING || echo CRASHED; }
```

| 输出 | 含义 |
|---|---|
| `DONE` | 有 DONE 文件（不管进程是否还在收尾） |
| `RUNNING` | 没 DONE 但进程活着 |
| `CRASHED` | 没 DONE 且进程没了 ← pid 的价值：立刻发现，不等超时 |
| `NOPID` | 没登记 pid，只能靠 DONE + 超时 |

pid **可选**：Slurm / Docker 拿不到进程号就留空，退化为 `NOPID` + 超时兜底。

实测过三态：在跑→`RUNNING`，被 kill→`CRASHED`，touch DONE→`DONE`。

---

## 6. 防静默失败

完全依赖 agent 配合，漏一步实验就**永远不会被等，且没有任何报错**。这是它最大的风险，用这些兜底：

### ① 超时兜底

登记超过 `maxHours`（默认 72 小时）还没 DONE → 唤醒提醒。

- 首次观察时间**落盘**（`.pi/runs-state.json`），否则 pi 一重启计时归零，长实验永远等不到超时
- **只提醒一次**，之后标记为已处理不再重复（避免每分钟骚扰）
- 超时后不再监控——已告诉你了，不能一直吵

### ② `track_run` 工具

把登记变成一次工具调用，比让 agent 手写文件可靠。校验绝对路径、pid 必须是数字、自动去重。

### ③ 区分「文件不存在」和「ssh 挂了」

直接用 `test -f` 的退出码判断的话，两者都会返回非零，会误报。
所以实际跑 `... && echo YES || echo NO`，输出既不是也不是 → 判定 ssh 出问题。

### ④ ssh 连续失败升级

失败 3 次 → 唤醒 LLM 诊断。**每次轮询会话只升级一次**（`escalatedOnce`），否则 ssh 长期故障会每 60 秒烧一次。

### ⑤ 合并窗口 + 去重

两次唤醒至少间隔 60 秒；报过的路径进已处理名单，不重复叫。

### ⑥ 配置未填拒绝启动

`sshHost` 没填 → `/rl` 直接拒绝开始循环。

---

## 7. 配置合并：占位值不覆盖

查找顺序「全局 → 项目级」，项目级覆盖全局。

坑：项目级配置里全是 `TODO` 时，直接覆盖会把全局已填好的值冲掉。
所以 `loadConfig()` **跳过值为 `PLACEHOLDER` 的键**，让「只填一部分的项目级配置」是安全的。

---

## 8. AGENTS.md 为什么特殊处理

pi 在同一个目录里只加载**一份**上下文文件（`AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md`）。
所以项目里已经有 `AGENTS.md` 时，再放一个新文件**不会被读**。

而 完全依赖 agent 遵守规则——规则没进去 = 实验永远不会被等 = 静默失败。
所以「已存在就跳过」是错的。

`/rl setup` 的处理：

```
没有 AGENTS.md              → 创建
有，但没有标记块            → 末尾追加 <!-- BEGIN/END research-loop --> 块（原有内容不动）
有标记块                    → 原地替换那一块（幂等，重跑不会堆积）
```

实测三态：新建 / 追加（原有内容保留）/ 更新（块只出现 1 次，是最新版）。

---

## 9. 模型切换（未实现，设计已定）

**做成共享库 `lib/model-chain.ts`，不做成独立扩展。**

理由：库没有自己的生命周期，只在被调用时做事。做成独立扩展会自己监听 `agent_end`，和任务扩展重复监听 → 一轮换两次模型。

**只用于长任务循环，不做全局自动切换。**

### 判断该不该换模型

| 错误类型 | 特征 | 该做什么 |
|---|---|---|
| key 无效 / 鉴权失败 | `401`、`Authentication Fails`、`invalid api key` | **不换模型**，得修配置 |
| 网络问题 | `fetch failed`、`connection`、`timeout` | **重试，不换** |
| 真限额 | `usage limit`、`rate limit`、`quota`、`Try again in ~XX min` | **换模型** |

响应里有 `resets_at`（额度恢复时间戳）——**冷却系统应读这个，不要硬编码 5 小时**。

⚠️ 换机器时 `auth.json` 不同步，排序链里的模型必须都已登录，否则 `setModel` 返回 false，切换链静默失败。

---

## 10. pi 扩展 API 速查

| 方法 | 作用 |
|---|---|
| `pi.registerTool(tool)` | 注册工具让 agent 调用 |
| `pi.registerCommand(name, { description, handler })` | 注册 `/xxx` 命令 |
| `pi.on(事件, handler)` | 监听事件 |
| `pi.setModel(model)` | 切模型，返回 `Promise<boolean>` |
| `pi.sendUserMessage(content, { deliverAs })` | 发用户消息，唤醒一轮 |
| `pi.exec(cmd, args, options)` | 跑 shell 命令 |
| `pi.appendEntry(customType, data)` | 往会话写自定义记录 |
| `ctx.ui.input(title, placeholder)` | **await 的文本输入**（`setup` 靠它做交互式向导） |
| `ctx.ui.confirm(title, message)` | **await 的确认**（装公钥时原地等） |
| `ctx.ui.notify(msg, level)` | 弹通知 |
| `ctx.mode` | `"tui"` / 非交互模式 |
| `ctx.isIdle()` / `ctx.hasUI` | 状态查询 |

`deliverAs`：`"followUp"` 排队等 agent 干完再投递（**从定时器里唤醒必须用这个**）；`"steer"` 立即打断。

### 关键源码位置

| 文件 | 内容 |
|---|---|
| `packages/coding-agent/src/core/extensions/types.ts` | 扩展 API 全部类型 |
| `packages/coding-agent/src/core/extensions/loader.ts` | 扩展发现与加载（jiti） |
| `packages/coding-agent/src/core/session-manager.ts` | `buildSessionContext()` 历史装配 |
| `packages/coding-agent/examples/extensions/` | 官方示例（60+ 个） |

---

## 11. 开发原则

1. **扩展只做机制，不做领域判断。** 指标怎么算、什么算"变好"、该往哪个方向试——全在 `AGENTS.md` 和 `goal.md` 里由人维护。
2. **能交给 agent 的就交给 agent。** 每多一处扩展自己操作服务器，就多一份兼容性负担。现在扩展里的 ssh 只剩轮询一处。
3. **先具体后抽象。** 共享库等第二个消费者出现再抽。
4. **沉默的失败最贵。** 任何"没报错但也没动静"的路径都要有兜底（超时、升级、去重）。
