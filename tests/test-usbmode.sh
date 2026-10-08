#!/bin/sh
# openfi-usbmode 的纯逻辑回归测试（不碰设备、不切模式）
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export OPENFI_USBMODE_STATE="/tmp/test-usbmode-state.$$"
# 被测脚本在固件的 files/ 覆盖目录里（不属于任何 LuCI 包）
SRC="$HERE/../files/usr/sbin/openfi-usbmode"

pass=0; fail=0
ok()  { printf '    ✅ %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '    ❌ %s\n' "$1"; fail=$((fail+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1（期望 $3，实际 $2）"; }

# 把脚本当库载入（--library 分支只定义函数，不执行探测）
set -- --library
. "$SRC"

# ── 模式名
eq "模式 2 = MBIM"   "$(mode_name 2)" "MBIM"
eq "模式 5 = NCM"    "$(mode_name 5)" "NCM"
eq "模式 3 = RNDIS"  "$(mode_name 3)" "RNDIS"
eq "模式 0 = RMNET"  "$(mode_name 0)" "RMNET"
eq "未知模式有兜底显示" "$(mode_name 9)" "未知(9)"

# ── 驱动映射（找网卡靠它，不能错）
eq "MBIM 用 cdc_mbim"    "$(mode_driver 2)" "cdc_mbim"
eq "NCM 用 cdc_ncm"      "$(mode_driver 5)" "cdc_ncm"
eq "RNDIS 用 rndis_host" "$(mode_driver 3)" "rndis_host"
eq "ECM 用 cdc_ether"    "$(mode_driver 1)" "cdc_ether"

# ── proto 映射（写错就上不了网）
eq "MBIM 要 proto mbim"  "$(mode_proto 2)" "mbim"
eq "NCM 用 dhcp"         "$(mode_proto 5)" "dhcp"
eq "RNDIS 用 dhcp"       "$(mode_proto 3)" "dhcp"

# ── 探测顺序：必须是 MBIM → NCM → RNDIS，且不含 QMI/RMNET
eq "探测顺序" "$CHAIN" "2 5 3"
case "$CHAIN" in
	*0*|*4*) bad "探测链里不该出现 RMNET(0)/QMI(4)" ;;
	*)       ok "探测链里没有 RMNET/QMI（展锐平台不支持）" ;;
esac

# ── 状态文件读写
state_set 5 wwan0 dhcp
eq "state 读 mode"  "$(state_get mode)"  "5"
eq "state 读 dev"   "$(state_get dev)"   "wwan0"
eq "state 读 proto" "$(state_get proto)" "dhcp"
grep -q '^ts=' "$STATE" && ok "state 里有时间戳" || bad "state 缺时间戳"
rm -f "$STATE"
eq "没状态文件时返回空" "$(state_get mode)" ""

# ── 失败记忆（关键安全机制：防止反复卡在坏模式上）
state_set 3 usb0 dhcp
eq "初始没有失败记忆" "$(state_get failed)" ""
state_mark_failed 2
eq "记下失败模式 2" "$(state_get failed)" "2"
state_mark_failed 5
eq "再记失败模式 5" "$(state_get failed)" "2 5"
state_mark_failed 2
eq "重复记不叠加" "$(state_get failed)" "2 5"
# 失败列表要能挡住跳过判断
failed="$(state_get failed)"
case " $failed " in
	*" 2 "*) ok "模式 2 会被跳过（不再重试）" ;;
	*)       bad "模式 2 没被挡住" ;;
esac
case " $failed " in
	*" 3 "*) bad "模式 3(RNDIS)不该在失败列表里" ;;
	*)       ok "RNDIS 不在失败列表（兜底始终可用）" ;;
esac
rm -f "$STATE"

# ── 参数校验
printf '\n    %s\n' "usbmode：通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ]
