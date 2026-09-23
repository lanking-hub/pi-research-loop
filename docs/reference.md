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
| `/rl setup` | 首次一站式：生成项目文件 + 配 ssh（需要 TUI 模式） |

## 工具（agent 可调用）

| 工具 | 干什么 | table 模式 |
|---|---|---|
| `track_run` | 登记实验路径 + 可选 pid | ✅ 用 |
| `start_run` | 起实验（**dir 模式**） | ❌ 用不到 |

## 监听的事件

`agent_settled` —— agent 一轮干完后立刻轮询一次（不等下一个间隔）。

---

## ssh 别名：固定常量，不用配置

```
research-loop-server
```

- 这是**实现细节**，`/rl setup` 自动写进 `~/.ssh/config`
- 用户完全不需要知道、不需要配置
- 万一你 `~/.ssh/config` 里已有同名条目且指向别的机器 → setup **报错并给两种解法**（绝不沿用，否则会静默连错服务器）

## 配置文件：**可选，默认不需要**

table 模式**零配置就能跑**。只有想调参时才建：

- `<项目>/.pi/research-loop.json`（项目级）
- `~/.pi/agent/research-loop.json`（全局）

项目级覆盖全局；**占位值（`TODO`）不会覆盖**上一层已填好的值，所以"只填一部分"是安全的。

| 字段 | 默认值 | 说明 | table 模式 |
|---|---|---|---|
| `sshHost` | `research-loop-server` | ssh 别名 | 一般不用改 |
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

---

## `/rl setup` 流程

```
A. 生成项目文件（静默）
   AGENTS.md      没有→创建；有→末尾追加标记块；已有块→原地更新
   .auto/goal.md  不存在才创建
   .auto/notes.md 不存在才创建
   .auto/runs.txt 不存在才创建
   （不生成任何配置文件）

B. ssh 向导
   1  检查 ssh 程序
   2  没有钥匙对就生成 ed25519（无密码）
   3  问：服务器地址        ← 问题 1
   4  问：登录用户名        ← 问题 2
   5  写 ~/.ssh/config（带冲突检测）
   6  ssh-keyscan 登记指纹
   7  试连；失败→打印装公钥命令→原地等你（最多 3 轮）  ← 唯一手动
   8  修服务器端 ~/.ssh 权限
   9  table 模式到此结束
   （dir 模式才继续：建 ~/bin、传脚本、问路径、写配置）
```

---

## 仓库文件

```
extensions/research-loop.ts   主扩展：命令 + 工具 + 轮询
lib/config.ts                 配置（含固定别名常量 SSH_ALIAS）
lib/ssh.ts                    runSsh ← 唯一的远程执行入口
lib/state.ts                  登记时间 / 已报过（落盘）
lib/paths.ts                  定位包内 templates/ server/
lib/setup.ts                  /rl setup 交互式向导
server/run_exp.sh             起实验（dir 模式）
server/run_status.sh          报状态（dir 模式）
server/test.sh                上面两个的回归测试
templates/AGENTS.research.md  agent 规则 ← 最关键（含 {{SSH_ALIAS}} 占位符）
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
你的项目目录（cwd，即你启动 pi 的地方）
├─ AGENTS.md                  你的 + 末尾的 research-loop 规则块
├─ .auto/
│   ├─ goal.md                你写：方向、指标、并发上限
│   ├─ notes.md               agent 写：进度、死胡同（每轮重写）
│   └─ runs.txt               正在跑的实验（路径 + 可选 pid）← agent 增删
└─ .pi/
    └─ runs-state.json        扩展自己记的（登记时间、已报过）← 不用管

远程服务器
└─ 什么都不用装（只有你的代码 + 实验输出目录）

pi 装包后的位置
└─ ~/.pi/agent/git/github.com/lanking-hub/pi-research-loop/
```

**扩展只写工作区（cwd）**，`~/.pi/agent/` 只读不写。
唯一碰全局的是 `/rl setup` 往 `~/.ssh/` **追加**（config / known_hosts / 钥匙）。

---

## 文档索引

| 文档 | 给谁 |
|---|---|
| `README.md` | 想快速了解 / 装上就用 |
| `docs/setup-windows.md` | 要在 Windows 上跑起来 |
| `docs/internals.md` | 要继续开发这个扩展 |
| `docs/reference.md` | 本页——查命令 / 配置 / 文件 |
