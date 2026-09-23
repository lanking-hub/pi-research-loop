# Windows 上手清单

从零到循环跑起来。按顺序做，每步做完可以 `/rl doctor` 验证。

> 研究代码**不需要**放在本地。本地只要一个「控制台目录」，代码在服务器上，agent 全程 ssh 操作。

---

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node | **≥ 22.19**（pi 靠 Node 原生跑 `.ts`） | `node -v` |
| OpenSSH 客户端 | Win10+ 自带 | `ssh -V` |
| pi | 已装 | `pi --version` |

> ⚠️ 非交互 shell 可能没有 npm/pi 在 PATH（nvm 不自动加载）。找不到就先 `export PATH="$HOME/.nvm/versions/node/<版本>/bin:$PATH"`。

## 2. 重新登录模型

**`auth.json` 不跨机器同步。** 换机器必须 `/login` 重新配一遍——各家模型都要重登。

漏了这步的症状是：切换模型静默失败（`setModel` 返回 false），或者报鉴权错。

## 3. 装扩展

```bash
pi install git:github.com/lanking-hub/pi-research-loop
```

> ⚠️ 如果你之前手动放过一个 `research-loop.ts` 在 `~/.pi/agent/extensions/`，**必须先删掉**，否则和装进来的包重复加载，`/rl` 和 `gpu_status` 会各注册两次。

## 4. 建控制台目录

```bash
mkdir C:\Users\<你>\research
cd C:\Users\<你>\research
pi
/rl init
/reload
```

`/rl init` 生成（已存在的不覆盖）：

```
AGENTS.md                   agent 规则
.auto/goal.md               你写方向
.auto/notes.md              agent 写进度
.pi/research-loop.json      项目级配置
```

`/reload` 是必须的——新生成的 `AGENTS.md` 要重启才加载。

> 两个目录是**分层**不是冗余：`.pi/` 是 pi 的平台目录（含机器相关的 ssh 配置，别进 git），
> `.auto/` 是你的内容目录（goal/notes 要进 git、跨机器同步）。

## 5. 一键整备（交互式）

```bash
/rl setup
```

**一步步问你**：服务器地址 → 登录用户名 → ssh 别名（默认 `research-server`）→ 服务器上 runs 目录 → 服务器上项目目录。

问完自动做完：

1. 检查 ssh 程序
2. 没有钥匙对就生成一把（ed25519，**无密码**，免密登录需要）
3. 把 `Host <别名>` 写进 `~/.ssh/config`
4. `ssh-keyscan` 登记服务器指纹（避开首连交互确认——`BatchMode` 答不了）
5. 试着免密连一次
6. 连上后：修 `~/.ssh` 权限、建 `~/bin`、上传并赋权两个管理脚本、建 runs 目录
7. **把 4 个配置值写进 `.pi/research-loop.json`**——不用手填

**唯一需要你动手的一步**：公钥装到服务器（要输一次服务器密码）。向导会打印命令并**在原地等你确认**：

```
type "C:\Users\<你>\.ssh\id_ed25519.pub" | ssh <用户>@<服务器> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

**另开一个终端**执行完，回来选 Yes，向导继续往下做。**不用重跑 `/rl setup`**。

（万一被中断：每一步都幂等，重跑会跳过已完成的。）

> **无密码私钥**：生成的钥匙没有密码（免密登录的前提）。别外传、别提交进 git。

服务器没装 `gpustat` 的话，把配置里的 `gpuCommand` 换成：

```
nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv
```

## 6. 自查

```bash
/rl doctor
```

逐项实测：配置字段 / ssh 免密连通 / runs 目录 / statusCommand / gpuCommand / 项目文件。全绿再下一步。

## 7. 写方向

`.auto/goal.md` 里写：方法、目标、看哪些指标（每个是越大越好还是越小越好）、大致方向、并发上限。

**这一步只能你写**，扩展替不了。

## 8. 启动

```bash
/rl start
```

然后直接跟 agent 说要做什么，它会起第一个实验，之后自动循环。

---

## Windows 特有的坑

**不要用 `wsl ssh`。** WSL 是另一套环境：独立的钥匙和指纹记录，没配过，会卡在指纹确认或报缺钥匙。

连服务器一律走**原生 ssh + `~/.ssh/config` 里的别名**：

```bash
ssh research-server "nvidia-smi"
```

这条同样写给 agent——`AGENTS.md` 模板里有「SSH 使用纪律」一节，别删。

---

## 中途怎么介入

| 想干嘛 | 怎么做 |
|---|---|
| 改长期方向 | 直接改 `.auto/goal.md`，下一轮生效 |
| 中途改细节 | 打字 **Enter** = steer |
| 让它先干完这轮 | **Alt+Enter** = follow-up |
| 彻底停下 | **Esc** |
| 看进度 | 读 `.auto/notes.md` |
