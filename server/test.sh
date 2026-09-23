#!/usr/bin/env bash
#
# run_exp.sh / run_status.sh 的回归测试。
#
# 用法：改完脚本跑一遍
#   ./test.sh
#
# 不需要服务器、不需要 ssh、不需要 GPU——全部在本地临时目录里用假命令跑。
#

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RUNS="$TMP/runs"
PROJ="$TMP/proj"
mkdir -p "$RUNS" "$PROJ"

pass=0
fail=0

check() { # check <说明> <实际> <期望>
	if [ "$2" = "$3" ]; then
		printf "  ✓ %s\n" "$1"
		pass=$((pass + 1))
	else
		printf "  ✗ %s\n      实际: %s\n      期望: %s\n" "$1" "$2" "$3"
		fail=$((fail + 1))
	fi
}

start() { # start <命令> → 打印 run id
	RUNS_DIR="$RUNS" PROJECT_DIR="$PROJ" bash "$HERE/run_exp.sh" \
		--gpu 0 --cmd-b64 "$(printf '%s' "$1" | base64)" | tail -1
}

state() { # state <runId> [STALL_HOURS]
	local line
	line=$(RUNS_DIR="$RUNS" STALL_HOURS="${2:-2}" bash "$HERE/run_status.sh" | grep "^$1 " || echo "")
	if [ -z "$line" ]; then
		echo "MISSING"
	else
		echo "${line#* }"
	fi
}

exitcode() { grep -m1 '^exit_code=' "$RUNS/$1/DONE" 2>/dev/null || echo "NO_DONE"; }

echo "1. 正常结束"
id=$(start 'echo hi; sleep 1')
sleep 2
check "状态 DONE" "$(state "$id")" "DONE"
check "退出码 0" "$(exitcode "$id")" "exit_code=0"
check "日志抓到输出" "$(grep -c 'hi' "$RUNS/$id/log.txt")" "1"

echo "2. 命令里含 exit（曾经的 bug：会连 subshell 一起退出，DONE 写不出）"
id=$(start 'echo fail; exit 1')
sleep 2
check "状态 DONE" "$(state "$id")" "DONE"
check "退出码 1" "$(exitcode "$id")" "exit_code=1"

echo "3. 任意非零退出码"
id=$(start 'sh -c "exit 7"')
sleep 2
check "退出码 7" "$(exitcode "$id")" "exit_code=7"

echo "4. 进程被 kill（模拟 OOM / 手动杀）"
id=$(start 'sleep 120')
sleep 1
kill -9 "$(cat "$RUNS/$id/pid")" 2>/dev/null
sleep 1
check "状态 CRASHED" "$(state "$id")" "CRASHED"

echo "5. 日志静止（卡死检测）"
id=$(start 'sleep 120')
sleep 2
check "阈值 0 秒时判 STALLED" "$(state "$id" 0)" "STALLED"
check "默认阈值 2 小时时仍 RUNNING" "$(state "$id" 2)" "RUNNING"

echo "6. run id 递增"
a=$(start 'sleep 60')
b=$(start 'sleep 60')
check "id 连续 +1" "$((10#$b - 10#$a))" "1"

echo "7. 命令含引号（验证 base64 传参可靠）"
id=$(start 'echo "hello world"')
sleep 2
check "引号内容完整" "$(grep -c 'hello world' "$RUNS/$id/log.txt")" "1"

echo "8. 必填环境变量缺失时应报错"
PROJECT_DIR="$PROJ" bash "$HERE/run_exp.sh" --gpu 0 --cmd "echo x" >/dev/null 2>&1
rc=$?
check "缺 RUNS_DIR 非零退出" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"

echo "9. 元信息文件齐全"
id=$(start 'sleep 60')
for f in cmd.txt gpu.txt project.txt pid log.txt RUNNING commit.txt patch.diff; do
	check "存在 $f" "$([ -e "$RUNS/$id/$f" ] && echo yes || echo no)" "yes"
done

echo ""
echo "通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
