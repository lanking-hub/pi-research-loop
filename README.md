# pi-research-loop

让 pi 在**远程 GPU 服务器**上自主跑科研迭代循环：起实验 → 等 → 有结果就唤醒 agent 分析 → 决定下一步 → 起下一个实验，不停循环。

适用于任何「改代码 / 调方法 → 跑实验 → 看结果」的计算机科研场景。

> **Windows 用户**：直接看 [docs/setup-windows.md](docs/setup-windows.md)，那是一份从零到跑通的完整清单。

---

## 核心思路

**扩展只做驱动和唤醒，不判定任何事。**

| 谁 | 做什么 |
|---|---|
| **扩展** | 定时 ssh 轮询 run 状态；有结果就唤醒 agent |
| **agent** | 读结果、调研、改代码、起下一个实验——全部在这一轮里做完 |
| **你** | 写 `goal.md` 定方向；中途随时插话；看 `notes.md` 掌握进度 |

扩展不认识你的指标、不做 keep/discard、不决定下一步。领域规则全在 `AGENTS.md` 里，由你维护。

### 两个关键取舍

**1. 轮询用代码，不用 LLM。** 轮询是一次 ssh（零 token），只有「有结果了→唤醒」才花钱。让 LLM 每隔一会儿去问「跑完了吗」，光等待就能烧掉几百万 token，还会把「还没好」这种废话永久塞进上下文。

**2. 结束文件是唯一契约。** 实验跑完写一个 `DONE` 文件，扩展只认「这个文件出现了」，**内容一律不看**。你想往里写什么指标、什么格式，扩展都不管——所以这套东西不需要你先把指标体系定死。

---

## 两种盯实验的方式

| | **table 模式**（默认，迭代用） | **dir 模式**（baseline 用） |
|---|---|---|
| 怎么起实验 | **你 / agent 决定**——`nohup`、`sbatch`、`docker`、`conda` 都行 | 固定的 `run_exp.sh` |
| 扩展盯什么 | `.auto/runs.txt` 里登记的路径下有没有 `DONE` | 固定 runs 目录 + 服务器脚本报状态 |
| 要在服务器部署脚本吗 | **不需要** | 需要 `server/*.sh` |
| 必填配置 | 只有 `sshHost` | `sshHost` + `runsPath` + `statusCommand` |
| 适合 | 变数多的迭代探索 | 流程固定的批量跑 |

**table 模式只认一个约定**：实验跑完时，在它的输出目录里写一个 `DONE` 文件（内容随便，建议放指标）。

怎么起实验完全不限制——所以 Slurm、Docker、多机、conda 环境全都支持。兼容性来自"不管你怎么起"。

配套的：

- `track_run` 工具 —— 起完实验登记路径 + 进程号，一次调用
- **进程号可选但强烈建议**：填了崩溃能**立刻**发现（`kill -0` 一次 ssh 就判出来），不填只能等超时
- 超时兜底 —— 登记超过 `maxHours`（默认 72 小时）还没 DONE 就提醒，防"忘了写 DONE"变成永久静默

切换：配置里 `"mode": "table"` 或 `"dir"`。

## 安装

```bash
pi install git:github.com/<你>/pi-research-loop
```

（也可以 `pi install git:github.com/<你>/pi-research-loop@v1` 钉版本。）

---

## 快速开始

### 1. 进项目目录，生成文件

pi 的文件都跟着当前目录走，所以先建个「控制台目录」（代码不用放本地）：

```bash
cd ~/research && pi
/rl init
```

| 生成的文件 | 用途 |
|---|---|
| `AGENTS.md` | agent 规则（已有就跳过，不覆盖） |
| `.auto/goal.md` | **你写**：方法、目标、看哪些指标、大致方向 |
| `.auto/notes.md` | agent 写：每轮重写，含死胡同 |
| `.pi/research-loop.json` | 项目级配置——**下一步由 `/rl setup` 自动填，不用手改** |

### 2. 一键整备

```bash
/rl setup
```

**交互式向导，一步步问**：服务器地址 → 用户名 → ssh 别名 → runs 目录 → 服务器上项目路径。

问完自动做完：生成钥匙对 → 写 `~/.ssh/config` 别名 → 登记指纹 → 建 `~/bin` 并上传管理脚本 → 建 runs 目录 → **把 4 个配置值写进 `.pi/research-loop.json`**。

唯一要你动手的一步：**把公钥装到服务器**（要输一次服务器密码）。向导会打印命令并**在原地等你确认**，装完选 Yes 就继续——**不用重跑 setup**。

### 3. 体检

```bash
/reload       # 让新生成的 AGENTS.md 生效
/rl doctor    # 逐项实测：ssh、目录、脚本、配置、项目文件
```

### 4. 写方向，开跑

`.auto/goal.md` 里写：方法、目标、看哪些指标、大致方向、并发上限。然后：

```bash
/rl start
```

跟着直接跟 agent 说要做什么，它会起第一个实验，之后自动循环。

### 命令一览

```bash
/rl               开始循环（默认动作；已在跑则显示状态）
/rl stop          停止
/rl status        看状态
/rl goal <文本>    往 .auto/goal.md 加一条建议，下一轮自动生效
/rl doctor        环境体检（只读）
/rl setup         首次一站式：生成项目文件 + 配 ssh + 写配置
```

`setup` 已经包含了原来 `init` 做的事，不用分开跑。

### 首次配置：用 `/rl doctor` 自查

上面 5 步里任何一步填错，症状都是「轮询静默不动」，很难查。所以先跑：

```bash
/rl doctor
```

它会实测并逐项报告：

| 检查项 | 不通过时 |
|---|---|
| 配置 4 个必填字段 | 列出缺哪几个，并告诉配置文件路径 |
| `ssh <host>` 免密连通 | 提示检查 `~/.ssh/config` 和 key |
| 服务器上 `runsPath` 是否存在 | 提示先 `mkdir -p` |
| `statusCommand` 能否执行、输出格式对不对 | 提示检查脚本是否传上去、`chmod +x`、`RUNS_DIR` 是否正确 |
| `gpuCommand` 能否执行 | 提示没装 gpustat 就换 nvidia-smi |
| 项目里有没有 `.auto/goal.md` / `.auto/notes.md` / `AGENTS.md` | 提示从 `templates/` 拷 |

全绿了再 `/rl start`。

---

## 中途介入

| 你想干嘛 | 怎么做 |
|---|---|
| 改长期方向 | 直接改 `.auto/goal.md`，下一轮自动生效 |
| 中途改某个细节 | 直接打字 **Enter** = steer，当前工具调用跑完就生效 |
| 让它先干完这轮 | **Alt+Enter** = follow-up |
| 彻底停下 | **Esc** |
| 看进度 | 读 `.auto/notes.md` |

不需要自定义命令，pi 自带这些交互。

---

## 目录结构

```
extensions/research-loop.ts   主扩展：轮询 + 唤醒 + gpu_status / start_run 工具
lib/config.ts                 配置读写（全局 → 项目级）
lib/ssh.ts                    ssh 执行（跨平台，不走本地 shell）
server/run_status.sh          服务器上跑，输出每个 run 的状态
server/run_exp.sh             服务器上跑，起一个受管理的实验
templates/                    拷到你项目里的模板
```

### 每个 run 的目录

```
runs/0007/
├─ cmd.txt        启动命令
├─ gpu.txt        用的哪张卡
├─ project.txt    项目路径
├─ pid            进程 PID
├─ log.txt        stdout/stderr
├─ RUNNING        起实验时创建，结束时删除
├─ commit.txt     git rev-parse HEAD
├─ patch.diff     git diff HEAD（未提交的改动）
└─ DONE           结束时创建：exit code + 结束时间 + 日志尾部
```

**不强制 git commit**，但用 `commit.txt` + `patch.diff` 保证每个 run 能追溯到确定的代码状态。

---

## 设计细节

- **状态机**：`DONE`→完成 / pid 死了→`CRASHED` / 日志超时未更新→`STALLED` / 否则→`RUNNING`
- **崩溃检测是必需的**：只看 `DONE` 的话，实验第 3 分钟 OOM 挂了，扩展会一直轮询到天荒地老
- **合并窗口 60s**：同时完成的几个 run 合成一次唤醒，省一轮 token
- **异常升级**：ssh 连续失败 3 次、或状态输出解析不出来 → 唤醒 LLM 让它诊断
- **防烧钱**：配置没填完时 `/rl start` 直接拒绝；异常升级每次轮询会话只做一次
- **自然停止**：没有任何 RUNNING 也没有待处理时，轮询自动停

---

## 常见问题

**为什么我的实验从来没被唤醒？**
大概率是你直接 `ssh ... nohup python` 起实验了——那样 run 不在 `runs/` 里，扩展根本看不到。必须用 `start_run` 工具或 `run_exp.sh`。

**服务器没装 gpustat？**
把 `gpuCommand` 换成 `nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv`。

**我想让 DONE 里结构化地放指标？**
改 `run_exp.sh` 里写 `DONE` 的那段就行——扩展不解析它的内容，你随便写。

---

## Quick Start (EN)

A pi extension that drives an autonomous research loop on a remote GPU server: launch experiment → wait → wake the agent when results land → analyze → next experiment.

```bash
pi install git:github.com/<you>/pi-research-loop
```

1. **SSH**: add a passwordless `Host` entry in `~/.ssh/config`.
2. **Server**: copy `server/*.sh` to the server, `chmod +x`.
3. **Config**: copy `templates/research-loop.json` to `~/.pi/agent/research-loop.json`, fill in `sshHost` / `runsPath` / `statusCommand` / `startCommand`.
4. **Init**: `cd <your-project> && pi`, then `/rl init` — generates `AGENTS.md`, `.auto/goal.md`, `.auto/notes.md`, `.pi/research-loop.json`.
5. **Set up**: run `/rl setup` — an interactive wizard that asks for server address, user, alias, runs dir and project dir, then generates keys, writes the ssh alias, registers the host key, uploads the scripts and **writes the config for you**. The only manual step (installing your public key, which needs your password once) is handled inline — it waits for your confirmation rather than making you re-run.
6. **Verify**: `/reload`, then `/rl doctor`.
7. **Run**: `/rl start`.

Key design: **the extension only polls and wakes — it never judges.** Polling is plain `ssh` (zero tokens); only the wake-up costs a model call. The `DONE` file is the only contract between your experiments and the extension, and its contents are never parsed — so you don't need a fixed metric schema.

---

## 文档

| 文档 | 给谁看 |
|---|---|
| [docs/setup-windows.md](docs/setup-windows.md) | **要在 Windows 上跑起来的人**——从零到循环跑通的完整清单 |
| [docs/internals.md](docs/internals.md) | 要继续开发这个扩展的人——实测确认过的机制、踩过的坑、未实现的设计 |

## 路线图

- [ ] **baseline 批量跑扩展**：拉取同类方法、逐个跑、结果落盘（设计未定，欢迎讨论）
- [ ] **模型排序链与限额自动切换**：`lib/model-chain.ts`，见 [internals §8](docs/internals.md#8-模型切换未实现设计已定)
- [ ] **`/rl init` 模板内嵌**：去掉对 `import.meta.url` 定位 `templates/` 的路径依赖（Windows 上若出问题就做）
- [ ] **结果结构化**：目前 `DONE` 放 exit code + 日志尾部，扩展不解析内容。想要结构化指标就改 `run_exp.sh` 里写 `DONE` 那段，扩展不用动

## License

MIT
