# 完整清单

代码里核出来的全量清单。这一页存在的理由：别再靠人问出来。

---

## 命令（1 个命令，6 种用法）

| 用法 | 干什么 |
|---|---|
| `/rl` | **开始循环**（默认动作；已在跑则显示状态） |
| `/rl stop` | 停止 |
| `/rl status` | 两行：循环状态 + 实验状态 |
| `/rl goal <文本>` | 往 `.auto/goal.md` 的「临时建议」加一条 |
| `/rl doctor` | 环境体检（只读） |
| `/rl setup` | 首次一站式：生成项目文件 + 配 ssh + 写配置 |

## 工具（agent 可调用）

| 工具 | 干什么 | table 模式 |
|---|---|---|
| `track_run` | 登记实验路径 + 可选 pid | ✅ 用 |
| `start_run` | 起实验（**dir 模式**） | ❌ 用不到 |

## 监听的事件

`agent_settled` —— agent 一轮干完后立刻轮询一次（不等 60 秒）。

---

## 配置文件：**可选**（默认不需要）

table 模式**零配置就能跑**。ssh 别名是固定常量 `research-loop-server`，
由 `/rl setup` 自动写进 `~/.ssh/config`，不暴露给用户。

只有想调参时才建 `<项目>/.pi/research-loop.json`（或全局 `~/.pi/agent/research-loop.json`，项目级覆盖全局）。

## 配置字段（11 个）

| 字段 | 默认值 | 说明 | table 模式 |
|---|---|---|---|
| `sshHost` | `research-loop-server` | ssh 别名 | ✅ 一般不用改 |
| `mode` | `"table"` | table / dir | ✅ |
| `runsFile` | `.auto/runs.txt` | 登记表路径 | ✅ |
| `maxHours` | `72` | 超时兜底 | ✅ |
| `pollIntervalSec` | `60` | 轮询间隔 | ✅ |
| `mergeWindowSec` | `60` | 两次唤醒最小间隔 | ✅ |
| `sshTimeoutSec` | `15` | 单次 ssh 超时 | ✅ |
| `sshFailEscalate` | `3` | 失败几次才叫醒 LLM | ✅ |
| `runsPath` | `TODO` | 固定 runs 目录 | ❌ dir 才用 |
| `statusCommand` | `TODO` | 报状态的命令 | ❌ dir 才用 |
| `startCommand` | `TODO` | 起实验的命令 | ❌ dir 才用 |

**table 模式一个都不用填**，其余都有默认值。

配置文件位置（可选）：`~/.pi/agent/research-loop.json`（全局）或 `<项目>/.pi/research-loop.json`（项目级，覆盖全局）。
占位值（`TODO`）不会覆盖上一层已填好的值，所以"只填一部分"是安全的。

---

## 仓库文件（20 个，约 2400 行）

```
extensions/research-loop.ts   主扩展：命令 + 工具 + 轮询
lib/config.ts                 配置读写
lib/ssh.ts                    runSsh ← 唯一的远程执行入口
lib/state.ts                  登记时间 / 已报过（落盘）
lib/paths.ts                  定位包内 templates/ server/
lib/setup.ts                  /rl setup 交互式向导
server/run_exp.sh             起实验（dir 模式）
server/run_status.sh          报状态（dir 模式）
server/test.sh                上面两个的回归测试
templates/AGENTS.research.md  agent 规则 ← 最关键
templates/goal.md             方向模板
templates/notes.md            进度模板
templates/runs.txt            登记表模板
docs/internals.md             机制与坑
docs/setup-windows.md         Windows 上手清单
docs/reference.md             本页
README.md LICENSE .gitignore package.json
```

**table 模式下 `server/` 三个文件完全用不到。**

---

## 运行时出现的文件

```
你的项目目录
├─ AGENTS.md                  你的 + 末尾的 research-loop 规则块
├─ .auto/
│   ├─ goal.md                你写：方向、指标、并发上限
│   ├─ notes.md               agent 写：进度、死胡同（每轮重写）
│   └─ runs.txt               正在跑的实验（路径 + 可选 pid）
└─ .pi/
    ├─ research-loop.json     配置
    └─ runs-state.json        扩展自己记的（登记时间、已报过）← 不用管

远程服务器
└─ 什么都不用装

pi 装包后的位置
└─ ~/.pi/agent/git/github.com/lanking-hub/pi-research-loop/
```

分工原则：`.auto/` 归人/agent，`.pi/` 归扩展，两边不写同一个文件。

---

## 文档索引

| 文档 | 给谁 |
|---|---|
| `README.md` | 想快速了解 / 装上就用 |
| `docs/setup-windows.md` | 要在 Windows 上跑起来 |
| `docs/internals.md` | 要继续开发这个扩展 |
| `docs/reference.md` | 要查某个命令 / 配置项 / 文件 |
