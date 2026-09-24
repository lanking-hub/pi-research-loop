# pi-research-loop

Run an **autonomous research iteration loop** on a remote GPU server, driven by [pi](https://github.com/earendil-works/pi): launch an experiment → wait → wake the agent when results land → analyze → next experiment → repeat.

Built for research automation — but the mechanism is generic: anything shaped *dispatch a long job → wait → act on the result* works, not just experiments. Most of what ships here (templates, docs, defaults) is tuned for research.

> **Windows users**: see [docs/setup-windows.md](docs/setup-windows.md) for a start-to-finish checklist.

---

## The idea

**The extension only polls and wakes. It never judges.**

| Who | Does what |
|---|---|
| **Extension** | Asks the server every 60s: did a registered experiment finish? Wakes the agent if so |
| **Agent** | Reads results, researches, changes the method/code, launches the next experiment — all inside one turn |
| **You** | Write `goal.md` to set direction, interrupt anytime, read `notes.md` for progress |

The extension knows nothing about your metrics. It does not keep/discard, and does not decide what to try next. All domain rules live in `AGENTS.md`, maintained by you.

### Two decisions that shape everything

**1. Polling is code, not the LLM.** A poll is one `ssh` call — zero tokens. Only the wake-up costs money. If the LLM asked "is it done yet?" every few minutes, waiting alone would burn millions of tokens, *and* all those "not yet" replies would stay in context forever, making every later turn more expensive.

**2. The `DONE` file is the only contract.** When an experiment finishes, something writes a `DONE` file. The extension only checks whether it exists — **it never reads the contents**. Write whatever metrics you want, in whatever format. You don't have to freeze a metric schema up front.

---

## The one contract

**When an experiment finishes, write a `DONE` file in its output directory.** Contents are up to you (metrics recommended).

That's it. How you launch is entirely unconstrained — `nohup`, `sbatch`, `docker`, `conda`, multi-node.

Alongside it, register the path so polling knows to look:

- `track_run` tool — register an experiment path + PID in one call
- **The PID is optional but strongly recommended**: with it, a crash is detected **immediately** (`kill -0`, one ssh); without it you wait for the timeout
- Timeout fallback — if a registered run still has no `DONE` after `maxHours` (default 72h), you get reminded, so a forgotten `DONE` can't become permanent silence

## Install

```bash
pi install git:github.com/lanking-hub/pi-research-loop
```

(Pin a version with `pi install git:github.com/lanking-hub/pi-research-loop@v1`.)

---

## Quick start

### 1. Open a console directory and run one command

Everything pi does is relative to the current directory, so make a **console directory** (your code does not need to be local):

```bash
cd ~/research && pi
/rl setup
```

It first generates project files:

| File | Purpose |
|---|---|
| `AGENTS.md` | Agent rules. If you already have one, it is **not appended blindly** — run `/rl agents` to let the agent merge it |
| `.auto/goal.md` | **You write**: method, goal, which metrics matter, rough direction |
| `.auto/notes.md` | Agent writes: progress, dead ends (rewritten each turn) |
| `.auto/runs.csv` | Running experiments (agent adds/removes) |

Then it configures ssh, asking only two things: **server address** and **username**.

After that it runs by itself: generate a keypair → write the alias into `~/.ssh/config` → register the host key → set up passwordless login.

(The ssh alias is a fixed internal constant, `research-loop-server`. You never need to know it or configure it. If your `~/.ssh/config` already has an entry with that name pointing somewhere else, setup detects it and reports an error rather than silently connecting to the wrong machine.)

The one manual step: **install your public key on the server** (needs your password once). The wizard prints the command and **waits in place** for you — run it in another terminal, come back, pick Yes, and it continues. **No need to re-run setup.**

### 2. Verify

```bash
/reload       # make the new AGENTS.md take effect
/rl doctor    # checks ssh connectivity, the runs table, project files
```

### 3. Set direction and start

Write `.auto/goal.md`: method, goal, which metrics, rough direction, concurrency limit. Then:

```bash
/rl
```

Then just tell the agent what to work on. It launches the first experiment, and the loop continues from there.

### What goes in goal.md — two examples

**Iteration and baselines are not two modes.** They're just two different things you
might write in `goal.md` — same loop, same table, same commands.

**Iterating on your own method:**

```markdown
# 我在做什么
优化我的 ReID 方法。当前最好 mAP 68.2（exp07）。

## 目标
mAP 提到 72 以上，CMC 不能掉。

## 看哪些指标
- mAP：越大越好（主指标）
- CMC：越大越好
- 显存：越小越好，超 20G 算失败

## 大致方向
1. 骨干换 Swin —— 论文显示有收益，先做这个
2. loss 加 center loss
一个方向试 2~3 次没效果就换，把「试过、没用」记进 notes。

## 资源约束
- 并发上限 2（服务器上还有别人，别占满）
```

**Reproducing baselines to compare against:**

```markdown
# 我在做什么
把待对比的方法逐个改造到能跑、出数。领域较新，以往的方法基本都要改造。

## 目标
至少 3 个可比方法在同一批数据集上跑出数，之后整理成对比表。

## 看哪些指标
先按各方法原始代码的输出原样记，口径之后统一。

## 大致方向
1. 先调研有哪些方法可以比（读文献、找开源实现），列出候选
2. 逐个拉代码、配环境、改接口和数据格式，让它跑起来
3. 数记全：指标、配置、环境坑、改了哪里。先别急着整理成表

## 资源约束
- 并发上限 2
```

(Section names match `templates/goal.md`; `我在做什么` and `大致方向` are the
two `/rl doctor` insists on — the rest is up to you.)

That's the entire difference. Nothing in the extension changes between the two.

You don't need separate directories either — **one console directory per session
is enough**: open one for iteration with the first goal, another elsewhere for
baselines with the second. The extension just watches whatever you register.

(If you do keep several goals in one project, `/rl goal -t <name> <text>` writes
to `.auto/goal-<name>.md`. Usually unnecessary.)

### Commands

```bash
/rl               Start the loop. With nothing registered, it tells the agent to start round one
/rl <one-liner>   Start the loop and hand that sentence to the agent as its first task
/rl stop          Stop
/rl status        Status
/rl goal <text>   Append a note to your goal file, picked up next turn
                  (-t <name> writes to .auto/goal-<name>.md)
/rl agents        Merge into an existing AGENTS.md (dedupe + condense) — done by the agent
/rl models        Edit the model chain (keyboard reorder); auto-switches when quota runs out
/rl doctor        Environment check (read-only)
/rl setup         First-time: generate project files + configure ssh (needs TUI mode)
/rl help          Show this list
```

---

## Steering it while it runs

| You want to | Do this |
|---|---|
| Change long-term direction | Edit `.auto/goal.md` — next turn picks it up |
| Correct something mid-flight | Type and press **Enter** (steer: applies after the current tool call) |
| Let it finish this turn first | **Alt+Enter** (follow-up) |
| Stop completely | **Esc** |
| See progress | Read `.auto/notes.md` |

No custom commands needed — these are built into pi.

---

## Working on the server

The agent decides **how** to launch. It is told to probe the environment first:

```bash
ssh research-loop-server "which sbatch; which docker; which conda; nvidia-smi -L"
```

| Environment | How to launch | End signal |
|---|---|---|
| `sbatch` present | `sbatch train.sh` | Write `DONE` at the end of the script; job id is **not** a PID, leave PID empty |
| `docker` present | `docker run ...` | Write `DONE` inside the container; leave PID empty |
| Bare metal | `nohup ... & echo $!` | That number is the PID — **pass it to `track_run`** |
| Needs conda | `conda run -n <env> python ...` | Same as above |

See [docs/environments.md](docs/environments.md) for cloud GPU platforms, Slurm details, and troubleshooting.

---

## AGENTS.md: two parts, owned differently

`AGENTS.md` is split by a marker pair:

```markdown
## 背景                          ← yours (project background, extracted from your existing doc)

<!-- BEGIN research-loop -->     ← upstream rules, verbatim
...
<!-- END research-loop -->

## 项目补充                       ← optional, yours again
```

| Part | Owner | On update |
|---|---|---|
| Outside the markers | **You** | Never touched |
| Inside the markers | Upstream template | Replaced wholesale |

**Why split it this way:** the rules must stay byte-identical to the template so they can be regenerated later. Your background must survive that regeneration. Putting them on opposite sides of the marker makes both true.

### If you already have an AGENTS.md

`/rl setup` will **not** append blindly — that would duplicate your background, connection info and code conventions. Instead run:

```bash
/rl agents
```

This hands the merge to the agent: it reads your existing `AGENTS.md` plus the rules template, and writes a merged version that

- condenses your background into 3–8 lines, keeping concrete facts (host alias, paths, dataset names)
- copies the rules **verbatim** (they must not be edited)
- drops anything that would now be duplicated
- keeps your unique bits (env quirks, dataset notes) as a `## 项目补充` section after the block

You can of course do it by hand — the rules template is at `templates/AGENTS.research.md` in the installed package.

## Design notes

- **State machine**: `DONE` exists → finished / PID gone → `CRASHED` / log untouched too long → `STALLED` / otherwise → `RUNNING`
- **Crash detection is mandatory**: watching only for `DONE`, an experiment that OOMs at minute 3 would be polled forever, silently
- **60s merge window**: runs that finish together are batched into one wake-up, saving a turn
- **Escalation**: 3 consecutive ssh failures, or unparseable state output → wake the LLM to diagnose
- **Burn protection**: refuses to start if config is incomplete; each escalation fires at most once per polling session
- **Natural stop**: when nothing is running and nothing is pending, polling stops by itself

---

## Layout

```
extensions/research-loop.ts   Main extension: commands + tools + polling
lib/config.ts                 Config (includes the fixed SSH_ALIAS constant)
lib/ssh.ts                    runRemote — the single remote-execution entry point
lib/state.ts                  Registration times / already-reported (persisted)
lib/paths.ts                  Locates bundled templates/
lib/setup.ts                  /rl setup interactive wizard
templates/                    Copied into your project by /rl setup
```

Runtime files:

```
your project dir
├─ AGENTS.md                  yours + the appended research-loop block
├─ .auto/
│   ├─ goal.md                you write: direction, metrics, concurrency limit
│   ├─ notes.md               agent writes: progress, dead ends
│   └─ runs.csv               running experiments (agent maintains)
└─ .pi/
    └─ runs-state.json        extension's own bookkeeping — ignore it
```

The extension **only writes inside your working directory**. `~/.pi/agent/` is read-only to it. The only global thing it touches is `~/.ssh/` during `/rl setup`, and only by **appending**.

---

## Docs

| Doc | For |
|---|---|
| [docs/setup-windows.md](docs/setup-windows.md) | Windows, start to finish |
| [docs/environments.md](docs/environments.md) | Cloud GPU / Slurm / Docker / conda + troubleshooting |
| [docs/internals.md](docs/internals.md) | Extending it: verified behaviours, gotchas, unimplemented designs |
| [docs/reference.md](docs/reference.md) | Full reference: commands, config fields, files |

> Setup docs are currently Chinese; translation is on the roadmap.

## Roadmap

- [x] **Local mode**: pi installed directly on the server, no ssh (`"sshHost": "local"`)
- [x] **Baseline support** — no separate extension or mode: baselines are just a different `goal.md`, same loop and same table
- [ ] **Translate docs to English**
- [x] **Model chain with quota-based failover**: `lib/model-chain.ts` + `/rl models`
- [ ] **Inline templates**: drop the `import.meta.url` dependency for locating `templates/`

## License

MIT

---

## 中文速览

在远程 GPU 服务器上跑自主科研迭代循环：起实验 → 等 → 有结果唤醒 agent → 分析 → 改方法/代码 → 起下一个。

为科研自动化而做，但机制是通用的——任何「派一个长任务 → 等 → 按结果继续」的场景都能用，
不限于跑实验。这里自带的模板、文档和默认值主要还是面向科研。

```bash
pi install git:github.com/lanking-hub/pi-research-loop
cd ~/research && pi
/rl setup        # 只问：服务器地址、用户名
/reload
/rl              # 开始循环
```

- **唯一约定**：实验跑完在输出目录写 `DONE` 文件（内容随意，建议放指标）。怎么起实验不限——Slurm / Docker / conda / 裸机都行
- **零配置、服务器零部署**
- **命令**：`/rl`（开始）、`stop`、`status`、`goal <文本>`、`agents`、`doctor`、`setup`、`help`
- **中途介入**：改 `.auto/goal.md`；打字 Enter = steer；Esc = 停

详细说明见 [docs/reference.md](docs/reference.md)（完整清单）、[docs/setup-windows.md](docs/setup-windows.md)（Windows 上手）。
