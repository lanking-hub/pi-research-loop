# 完整清单

代码里核出来的全量清单。这一页存在的理由：别再靠人问出来。

---

## 命令（1 个命令，6 种用法）

| 用法 | 干什么 |
|---|---|
| `/rl` | **开始循环**（默认动作；已在跑则显示状态） |
| `/rl stop` | 停止 |
| `/rl status` | 两行：循环状态 + 实验状态 |
| `/rl goal <文本>` | 往 goal 的「临时建议」加一条，下一轮 agent 自动读到 |
| `/rl goal -t <工作流> <文本>` | 写到 `.auto/goal-<工作流>.md`（按工作流拆 goal 时用） |
| `/rl agents` | 已有 AGENTS.md 时让 agent 合并（去重 + 精简），背景放块外、规则逐字保留 |
| `/rl doctor` | 环境体检（只读） |
| `/rl setup` | 首次一站式：生成项目文件 + 配 ssh（需要 TUI 模式） |
| `/rl help` | 显示所有命令的说明（`-h` / `--help` / `?` 同样有效） |

## 工具（agent 可调用）

只有一个：`track_run` —— 登记实验路径 + 可选 pid + 可选 `track` / `note` 标签。

起实验**不走工具**：怎么起是 agent 自己的事（nohup / sbatch / docker / conda 都行），
扩展完全不关心，也不提供相关工具。

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

**零配置就能跑**。只有想调参时才建：

- `<项目>/.pi/research-loop.json`（项目级）
- `~/.pi/agent/research-loop.json`（全局）

项目级覆盖全局；**占位值（`TODO`）不会覆盖**上一层已填好的值，所以"只填一部分"是安全的。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `sshHost` | `research-loop-server` | ssh 别名，一般不用改 |
| `runsFile` | `.auto/runs.csv` | 登记表路径 |
| `maxHours` | `72` | 超时兜底 |
| `pollIntervalSec` | `60` | 轮询间隔 |
| `mergeWindowSec` | `60` | 两次唤醒最小间隔 |
| `sshTimeoutSec` | `15` | 单次 ssh 超时 |
| `sshFailEscalate` | `3` | ssh 连续失败几次才叫醒 LLM |

---

## 登记表 `.auto/runs.csv`

一行一个正在跑的实验。起完实验调 `track_run` 登记，处理完把那行删掉。

```csv
path,pid,track,note
/data/proj/iter/outputs/exp12,88321,iter,试 CBAM 注意力
/data/proj/baselines/methodA/out,88231,baseline,methodA / SYSU / seed0
```

| 列 | 必填 | 扩展怎么用 |
|---|---|---|
| `path` | ✅ | 盯这个目录下有没有 `DONE` |
| `pid` | 可选 | 判崩溃。不填就只能等 `maxHours` 超时 |
| `track` | 可选 | **只透传**，原样进唤醒消息 |
| `note` | 可选 | **只透传**，原样进唤醒消息 |

**`track` / `note` 扩展不解析含义**——它不知道 `iter` 和 `baseline` 是什么，只是把字符串搬进唤醒消息。作用只有一个：你被唤醒时一眼知道该读哪个 `goal`。

### 格式怎么定的

按 `runsFile` 的**扩展名**自动切换解析器，向后兼容：

| 文件 | 解析方式 |
|---|---|
| `*.csv` | CSV，`path,pid,track,note` 四列，跳过表头和 `#` 注释 |
| 其他 | 旧格式：空白分隔 + 行尾纯数字当 pid，`#` 开头是注释 |

想继续用旧格式就在配置里写 `"runsFile": ".auto/runs.txt"`，行为完全不变。

### 多个工作流怎么共存

一份表就行，不要拆成多份——拆了就要跑多个循环（= 多个 pi 实例），它们互相看不见，会抢同一批卡。

用 `track` 列区分工作流，用 `note` 写清楚在试什么。

`goal` 默认只有一份 `.auto/goal.md`。要按工作流拆开就改名成
`.auto/goal-iter.md` / `.auto/goal-baseline.md`（本地放代码的话用子目录也行，
见 `templates/AGENTS.research.md` 的工作流表）。
拆开之后：

- `/rl goal -t baseline <文本>` → 写到 `.auto/goal-baseline.md`
- `/rl doctor` 会认出所有 `goal*.md`，不会因为改名而误报缺失
- 记得把 AGENTS.md 里那张工作流表改成你实际的文件名——**那是给 agent 的索引**

---

## `/rl setup` 流程

```
A. 生成项目文件（静默）
   AGENTS.md      没有→创建；有→末尾追加标记块；已有块→原地更新
   .auto/goal.md  不存在才创建
   .auto/notes.md 不存在才创建
   .auto/runs.csv 不存在才创建
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
   9  到此结束（不传任何脚本、不写任何配置文件）
```

---

## 仓库文件

```
extensions/research-loop.ts   主扩展：命令 + 工具 + 轮询
lib/config.ts                 配置（含固定别名常量 SSH_ALIAS）
lib/ssh.ts                    runSsh ← 唯一的远程执行入口
lib/state.ts                  登记时间 / 已报过（落盘）
lib/paths.ts                  定位包内 templates/
lib/setup.ts                  /rl setup 交互式向导
templates/AGENTS.research.md  agent 规则 ← 最关键（含 {{SSH_ALIAS}} 占位符）
templates/goal.md             方向模板
templates/notes.md            进度模板
templates/runs.csv            登记表模板
docs/internals.md             机制与坑
docs/setup-windows.md         Windows 上手清单
docs/reference.md             本页
README.md LICENSE .gitignore package.json
```

**没有需要部署到服务器上的东西**——扩展只 ssh 上去执行一句 `test -f <路径>/DONE`。

---

## 运行时出现的文件

```
你的项目目录（cwd，即你启动 pi 的地方）
├─ AGENTS.md                  你的 + 末尾的 research-loop 规则块
├─ .auto/
│   ├─ goal.md                你写：方向、指标、并发上限
│   ├─ notes.md               agent 写：进度、死胡同（每轮重写）
│   └─ runs.csv               正在跑的实验（路径 + 可选 pid）← agent 增删
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
