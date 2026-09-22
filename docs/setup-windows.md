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

**`auth.json` 不跨机器同步。** 换机器必须 `/login` 重新配一遍——GPT 订阅、智谱、DeepSeek 各家都要重登。

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

## 5. 配 ssh 免密

`%USERPROFILE%\.ssh\config`：

```
Host gpu-server
    HostName <服务器地址>
    User <用户名>
    IdentityFile ~/.ssh/<你的 key>
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

**必须免密**——扩展用 `BatchMode=yes`，不会也不该碰密码。
`ControlMaster` 不是必需，但能省掉每次轮询的握手。

## 6. 准备服务器

```bash
ssh gpu-server 'mkdir -p ~/runs'
scp server/run_exp.sh server/run_status.sh gpu-server:~/bin/
ssh gpu-server 'chmod +x ~/bin/run_exp.sh ~/bin/run_status.sh'
```

服务器没装 `gpustat` 就把 `gpuCommand` 换成：

```
nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv
```

## 7. 填配置

`.pi/research-loop.json` 里 4 个 `TODO`：

```json
{
  "sshHost": "gpu-server",
  "runsPath": "/home/<你>/runs",
  "statusCommand": "RUNS_DIR=/home/<你>/runs /home/<你>/bin/run_status.sh",
  "startCommand": "RUNS_DIR=/home/<你>/runs PROJECT_DIR=/home/<你>/<项目> /home/<你>/bin/run_exp.sh"
}
```

## 8. 自查

```bash
/rl doctor
```

逐项实测：配置字段 / ssh 免密连通 / runs 目录 / statusCommand / gpuCommand / 项目文件。全绿再下一步。

## 9. 写方向

`.auto/goal.md` 里写：方法、目标、看哪些指标（每个是越大越好还是越小越好）、大致方向、并发上限。

**这一步只能你写**，扩展替不了。

## 10. 启动

```bash
/rl start
```

然后直接跟 agent 说要做什么，它会起第一个实验，之后自动循环。

---

## Windows 特有的两个待验证点

1. **`/rl init` 的 `import.meta.url` 在 Windows 路径下能否定位到 `templates/`**
   失败的话（提示"找不到模板目录"），手动从包安装目录拷 `templates/` 也行；长期解法是把模板内嵌进扩展。
2. **`pi install git:` 在 Windows 上的安装目录**
   影响你手动找 `templates/` 的位置。

---

## 中途怎么介入

| 想干嘛 | 怎么做 |
|---|---|
| 改长期方向 | 直接改 `.auto/goal.md`，下一轮生效 |
| 中途改细节 | 打字 **Enter** = steer |
| 让它先干完这轮 | **Alt+Enter** = follow-up |
| 彻底停下 | **Esc** |
| 看进度 | 读 `.auto/notes.md` |
