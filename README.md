# pi-research-loop

让 pi 在**远程 GPU 服务器**上自主跑科研迭代循环：起实验 → 等 → 有结果就唤醒 agent 分析 → 决定下一步 → 起下一个实验，不停循环。

适用于任何「改代码 / 调方法 → 跑实验 → 看结果」的计算机科研场景。

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

## 安装

```bash
pi install git:github.com/<你>/pi-research-loop
```

（也可以 `pi install git:github.com/<你>/pi-research-loop@v1` 钉版本。）

---

## 快速开始

### 1. 配 ssh 免密

`~/.ssh/config`：

```
Host gpu-server
    HostName <服务器地址>
    User <用户名>
    IdentityFile ~/.ssh/<你的 key>
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

**必须免密**（扩展用 `BatchMode=yes`，不会也不该碰密码）。`ControlMaster` 不是必需，但能省掉每次轮询的握手开销。

### 2. 部署服务器脚本

把 `server/` 下的两个脚本放到服务器上并加执行权限：

```bash
scp server/*.sh gpu-server:~/bin/
ssh gpu-server 'chmod +x ~/bin/run_exp.sh ~/bin/run_status.sh'
```

### 3. 写配置

把 `templates/research-loop.json` 拷到 `~/.pi/agent/research-loop.json`（全局）或 `<项目>/.pi/research-loop.json`（项目级，覆盖全局），填上：

```json
{
  "sshHost": "gpu-server",
  "runsPath": "/home/me/runs",
  "statusCommand": "RUNS_DIR=/home/me/runs /home/me/bin/run_status.sh",
  "startCommand": "RUNS_DIR=/home/me/runs PROJECT_DIR=/home/me/proj /home/me/bin/run_exp.sh",
  "gpuCommand": "gpustat --no-color"
}
```

### 4. 给你的项目加规则

把 `templates/AGENTS.research.md` 拷成项目根目录的 `AGENTS.md`（已有就追加——pi 会叠加加载多份 AGENTS.md，不会覆盖）。

再建 `templates/goal.md` → `.auto/goal.md`（你写方向）、`templates/notes.md` → `.auto/notes.md`（agent 写进度）。

### 5. 跑

重启 pi（`/reload` 也行），然后：

```bash
/rl status    # 看状态
/rl start     # 启动轮询
/rl stop      # 停
/rl poll      # 立刻查一次
```

然后直接跟 agent 说你要做什么，它会起第一个实验，之后就是自动循环了。

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
4. **Rules**: copy `templates/AGENTS.research.md` to your project as `AGENTS.md`; add `.auto/goal.md` and `.auto/notes.md`.
5. **Run**: restart pi, then `/rl start`.

Key design: **the extension only polls and wakes — it never judges.** Polling is plain `ssh` (zero tokens); only the wake-up costs a model call. The `DONE` file is the only contract between your experiments and the extension, and its contents are never parsed — so you don't need a fixed metric schema.

---

## License

MIT
