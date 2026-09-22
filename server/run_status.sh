#!/usr/bin/env bash
#
# run_status.sh — 输出每个 run 的状态，每行 "<runId> <STATE>"
#
#   STATE: RUNNING | DONE | CRASHED | STALLED
#
# 用法（部署在服务器上，由扩展通过 ssh 调用）:
#   RUNS_DIR=/home/me/runs /path/to/run_status.sh
#   RUNS_DIR=/home/me/runs STALL_HOURS=2 /path/to/run_status.sh
#
# 判定顺序:
#   DONE 文件存在        -> DONE
#   pid 进程已死         -> CRASHED
#   日志超过 STALL_HOURS 未更新 -> STALLED
#   否则                 -> RUNNING

set -uo pipefail

RUNS_DIR="${RUNS_DIR:?RUNS_DIR 未设置}"
STALL_HOURS="${STALL_HOURS:-2}"

[ -d "$RUNS_DIR" ] || exit 0

now=$(date +%s)
stall_secs=$((STALL_HOURS * 3600))

for d in "$RUNS_DIR"/*; do
	[ -d "$d" ] || continue
	id=$(basename "$d")

	if [ -f "$d/DONE" ]; then
		echo "$id DONE"
		continue
	fi

	pid=""
	[ -f "$d/pid" ] && pid=$(tr -d '[:space:]' <"$d/pid" 2>/dev/null)

	if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
		echo "$id CRASHED"
		continue
	fi

	# 进程活着，再看日志是不是还动
	log="$d/log.txt"
	if [ -f "$log" ]; then
		mtime=$(stat -c %Y "$log" 2>/dev/null || stat -f %m "$log" 2>/dev/null || echo "")
		if [ -n "$mtime" ] && [ $((now - mtime)) -gt "$stall_secs" ]; then
			echo "$id STALLED"
			continue
		fi
	fi

	echo "$id RUNNING"
done
