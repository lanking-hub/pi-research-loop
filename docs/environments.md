# Environments & Troubleshooting

table mode does not care how you launch experiments — it only looks for a `DONE` file.
This page covers how that works on common setups, and what to check when nothing happens.

---

## Probe first

Different machines differ a lot. Before launching, the agent is told to look around:

```bash
ssh research-loop-server "which sbatch; which docker; which conda; nvidia-smi -L"
```

Useful extra probes:

```bash
sinfo                 # is there a Slurm cluster?
squeue -u $USER       # what am I running?
ls /opt               # what's installed system-wide?
conda env list        # which environments exist?
df -h .               # disk space (a full disk is a common silent failure)
```

---

## Common setups

### Bare metal / cloud GPU instance (AutoDL, 恒源云, AWS, GCP, ...)

Most cloud GPU platforms are just a Linux box you ssh into. Same as bare metal.

```bash
cd /your/project && nohup python train.py > /your/output/exp12/log.txt 2>&1 & echo $!
```

The number printed is the PID — **pass it to `track_run`** so crashes are caught immediately.

Then make sure `DONE` gets written, either by modifying your training code or:

```bash
cd /your/project && (nohup python train.py > /your/output/exp12/log.txt 2>&1; touch /your/output/exp12/DONE) & echo $!
```

Using `conda`: put it in the command —

```bash
conda run -n myenv python train.py
```

### Slurm cluster

```bash
sbatch train.sh
```

Two rules:

1. **The batch script must write `DONE`** when training ends:
   ```bash
   #!/bin/bash
   #SBATCH --gres=gpu:1
   python train.py
   echo "exit_code=$?" > /your/output/exp12/DONE
   ```
2. **Leave the PID empty.** A Slurm job id is not a PID, and the job runs on a compute node — `kill -0` from the login node is meaningless. Without a PID you rely on `DONE` + the timeout fallback, so consider setting `maxHours` close to your real job duration.

Optional: register the job id anyway in `runs.csv` as a comment so you can find it later.

### Docker / Singularity

```bash
docker run --gpus '"device=0"' -v /your:/your image \
  bash -c "cd /your/project && python train.py && touch /your/output/exp12/DONE"
```

Leave the PID empty (the PID inside the container is not visible from the host in a useful way), or record `docker inspect` / the container id instead.

### Multiple machines

Config is per-directory, so run one console directory per machine, or override `sshHost` in the project config. The alias itself is fixed; if you need a second server, set `"sshHost": "my-other-name"` in that project's `.pi/research-loop.json` and run `/rl setup` there.

---

## Troubleshooting

### The experiment finished but nothing happened

Almost always one of these:

| Cause | Check |
|---|---|
| Never registered | Is the path in `.auto/runs.csv`? `/rl status` shows the count |
| `DONE` not written | `ssh research-loop-server "ls -la <path>"` |
| Wrong path registered | Must be the **absolute** path on the server |
| Registered but stale | The run was already reported once; it won't be announced again |
| Polling not running | `/rl status` — if stopped, `/rl` |

### Nothing is ever detected — silent loop

Symptom: no errors, no wake-ups, nothing moves.

1. `/rl doctor` — it checks ssh connectivity and the table
2. `ssh research-loop-server "echo ok"` by hand — should return `ok` with no password prompt
3. Check `.auto/runs.csv` actually has lines (not just comments)

### ssh problems

| Symptom | Fix |
|---|---|
| Asks for a password | Key not installed. `/rl setup` prints the install command |
| `Permission denied (publickey)` | Public key not in `~/.ssh/authorized_keys`, or server `~/.ssh` permissions wrong (`chmod 700 ~/.ssh`, `chmod 600 ~/.ssh/authorized_keys`) |
| `Host key verification failed` | Fingerprint unknown. `/rl setup` registers it via `ssh-keyscan` |
| `Bad owner or permissions` | `chmod 600 ~/.ssh/config`, `chmod 600 ~/.ssh/id_ed25519` |

**On Windows, never use `wsl ssh`.** WSL is a separate environment with its own keys and known_hosts; it will hang on host-key confirmation. Always use native `ssh.exe` with the configured alias.

### Timeout fired but the experiment was fine

`maxHours` defaults to 72. If your epochs take longer than that to produce output, raise it:

```json
{ "maxHours": 168 }
```

### Timeout fired and the experiment really did die

That's the fallback doing its job. Read the log, fix it, remove the line from `.auto/runs.csv`, relaunch.

### A finished run keeps being polled

Remove its line from `.auto/runs.csv`. The extension forgets paths that are no longer listed.

### Alias conflict

```
✗ 冲突：~/.ssh/config 里的 research-loop-server 已存在，且指向 <other host>
```

Either remove/rename that block manually, or set `"sshHost": "some-other-name"` in `.pi/research-loop.json` and re-run `/rl setup`.

### I want structured metrics in DONE

Just write them. The extension never parses `DONE` contents — the agent reads it. A common shape:

```
exit_code=0
finished_at=2026-09-23T03:56:25Z
mAP=0.812
rank1=0.901
AF=0.043
```

---

## Still stuck

1. `/rl doctor` and read the output carefully
2. Test the exact command by hand: `ssh research-loop-server "test -f <path>/DONE && echo YES || echo NO"`
3. If it prints `NO` but the file exists, the path is wrong (relative vs absolute is the usual culprit)
