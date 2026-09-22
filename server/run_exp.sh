#!/usr/bin/env bash
#
# run_exp.sh — 起一个受管理的实验 run
#
# 用法:
#   RUNS_DIR=/home/me/runs PROJECT_DIR=/home/me/proj \
#     /path/to/run_exp.sh --gpu 0,1 --cmd-b64 "$(printf 'python train.py' | base64)"
#
#   --gpu       CUDA_VISIBLE_DEVICES
#   --cmd       明文命令（不含单引号时可用）
#   --cmd-b64   base64 编码的命令（推荐，绕开所有引号问题）
#
# 会创建 $RUNS_DIR/<id>/ :
#   cmd.txt gpu.txt project.txt pid log.txt RUNNING commit.txt patch.diff
# 实验进程退出后写 DONE（含 exit code、结束时间、日志尾部），并删除 RUNNING。
#
# 注意: 不强制 git commit。用 commit.txt + patch.diff 记录当时的代码状态，
#       这样即使没提交也能复现跑的那份代码。

set -uo pipefail

RUNS_DIR="${RUNS_DIR:?RUNS_DIR 未设置}"
PROJECT_DIR="${PROJECT_DIR:?PROJECT_DIR 未设置}"
TAIL_LINES="${TAIL_LINES:-80}"

gpu=""
cmd=""

while [ $# -gt 0 ]; do
	case "$1" in
	--gpu)
		gpu="$2"
		shift 2
		;;
	--cmd)
		cmd="$2"
		shift 2
		;;
	--cmd-b64)
		cmd=$(echo "$2" | base64 -d 2>/dev/null)
		shift 2
		;;
	*)
		echo "未知参数: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$cmd" ]; then
	echo "缺少 --cmd 或 --cmd-b64" >&2
	exit 2
fi

mkdir -p "$RUNS_DIR"

# 递增 run id（四位数字）
last=0
for d in "$RUNS_DIR"/*; do
	[ -d "$d" ] || continue
	id=$(basename "$d")
	case "$id" in
	'' | *[!0-9]*) continue ;;
	esac
	n=$((10#$id))
	[ "$n" -gt "$last" ] && last=$n
done
next=$(printf "%04d" $((last + 1)))

dir="$RUNS_DIR/$next"
mkdir -p "$dir"

echo "$cmd" >"$dir/cmd.txt"
echo "$gpu" >"$dir/gpu.txt"
echo "$PROJECT_DIR" >"$dir/project.txt"

# 记录代码状态（不强制 commit）
(cd "$PROJECT_DIR" 2>/dev/null && git rev-parse HEAD 2>/dev/null) >"$dir/commit.txt" 2>/dev/null || : >"$dir/commit.txt"
(cd "$PROJECT_DIR" 2>/dev/null && git diff HEAD 2>/dev/null) >"$dir/patch.diff" 2>/dev/null || : >"$dir/patch.diff"

: >"$dir/RUNNING"
: >"$dir/log.txt"

(
	cd "$PROJECT_DIR" || exit 1
	export CUDA_VISIBLE_DEVICES="$gpu"
	eval "$cmd" >>"$dir/log.txt" 2>&1
	code=$?
	{
		echo "exit_code=$code"
		echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo ""
		echo "----- log.txt 最后 $TAIL_LINES 行 -----"
		tail -n "$TAIL_LINES" "$dir/log.txt"
	} >"$dir/DONE"
	rm -f "$dir/RUNNING"
) &

echo $! >"$dir/pid"

# 输出 run id，扩展会原样返回给 agent
echo "$next"
