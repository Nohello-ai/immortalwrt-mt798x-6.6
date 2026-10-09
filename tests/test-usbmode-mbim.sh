#!/bin/sh
#
# 回归测试:proto mbim 的 device 参数必须是【字符设备 /dev/cdc-wdmN】，不是网卡名。
#
# 为什么必须有这个测试：
#   OpenWrt 的 /lib/netifd/proto/mbim.sh 里有
#       [ -c "$device" ] || { echo "The specified control device does not exist"; ... }
#   传网卡名（如 usb0 / wwan0）会直接失败，接口起不来。
#   探测脚本的 CHAIN 是 "2 5 3"（MBIM 优先），所以这个 bug 会让
#   "MBIM 优先"永远试不成功，一路退到 NCM/RNDIS —— 而且只在真机上才暴露。
#
# 这个测试只依赖脚本本身和 /dev 下有没有假字符设备，不需要真设备。
#
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
F="${OPENFI_USBMODE_SCRIPT:-$HERE/../files/usr/sbin/openfi-usbmode}"
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 抽出被测函数（脚本底部会跑 main，不能直接 source 整个文件）
{
	echo 'REENUM_WAIT=4'
	echo 'log() { :; }'
	sed -n '/^wait_cdc_wdm()/,/^}/p' "$F"
	sed -n '/^proto_device()/,/^}/p' "$F"
} > "$TMP/fn.sh"

sh -n "$TMP/fn.sh" 2>/dev/null || { bad "抽出的函数语法错误"; exit 1; }
ok "抽出的函数语法正常"

# ---------- 1. 非 mbim 的 proto 必须原样返回网卡名 ----------
# shellcheck disable=SC1090
. "$TMP/fn.sh"

for pair in "usb0:dhcp" "wwan0:dhcp" "wwan0:dhcpv6" "eth1:dhcp"; do
	dev="${pair%%:*}"; proto="${pair##*:}"
	got="$(proto_device "$dev" "$proto" 2>/dev/null)"
	if [ "$got" = "$dev" ]; then
		ok "proto_device $dev $proto → $dev"
	else
		bad "proto_device $dev $proto 应返回 $dev，实际 '$got'"
	fi
done

# ---------- 2. mbim 且没有 cdc-wdm：必须失败，不能回退成网卡名 ----------
# （回退成网卡名 = 静默写错配置，正是原来的 bug）
if [ -e /dev/cdc-wdm0 ]; then
	echo "  ⏭  跳过"无 wdm"用例：本机已有 /dev/cdc-wdm0"
else
	if got="$(proto_device usb0 mbim 2>/dev/null)"; then
		bad "没有 /dev/cdc-wdm* 时不该成功，却返回 '$got'"
	else
		ok "没有 /dev/cdc-wdm* 时正确失败（调用方会记为失败并退到下一个模式）"
	fi
fi

# ---------- 3. mbim 且有假字符设备：必须返回 /dev/cdc-wdmN ----------
FAKE=/dev/cdc-wdm_openfi_test
mknod "$FAKE" c 180 200 2>/dev/null || true
if [ -c "$FAKE" ]; then
	for dev in usb0 wwan0; do
		got="$(proto_device "$dev" mbim 2>/dev/null)"
		case "$got" in
			/dev/cdc-wdm*) ok "proto_device $dev mbim → $got" ;;
			"")            bad "proto_device $dev mbim 返回空" ;;
			*)             bad "proto_device $dev mbim 返回 '$got'，应该是 /dev/cdc-wdm*" ;;
		esac
	done
	rm -f "$FAKE"
else
	echo "  ⏭  跳过"有字符设备"用例：mknod 受限（测试环境无法创建设备节点）"
fi

# ---------- 4. set_wan 的分支：mbim 要 wan6=none，dhcp 要 wan6=dhcpv6 ----------
mkdir -p "$TMP/bin"
cat > "$TMP/bin/uci" <<'EOF'
#!/bin/sh
echo "uci $*" >> "$UCI_LOG"
EOF
chmod 755 "$TMP/bin/uci"

{
	echo 'log() { :; }'
	echo 'proto_device() { case "$2" in mbim) echo "/dev/cdc-wdm0";; *) echo "$1";; esac; }'
	sed -n '/^set_wan()/,/^}/p' "$F"
} > "$TMP/sw.sh"

UCI_LOG="$TMP/uci.log"; export UCI_LOG
: > "$UCI_LOG"
PATH="$TMP/bin:$PATH" sh -c ". '$TMP/sw.sh'; set_wan usb0 mbim" 2>/dev/null

if grep -q 'network.wan.device=/dev/cdc-wdm0' "$UCI_LOG"; then
	ok "MBIM：wan.device 写的是 /dev/cdc-wdm0"
else
	bad "MBIM：wan.device 不是 /dev/cdc-wdm0 —— $(grep wan.device "$UCI_LOG" | head -1)"
fi
if grep -q 'network.wan.proto=mbim' "$UCI_LOG"; then
	ok "MBIM：wan.proto=mbim"
else
	bad "MBIM：wan.proto 不是 mbim"
fi
if grep -q 'network.wan6.proto=none' "$UCI_LOG"; then
	ok "MBIM：wan6 关掉了（IPv6 由 MBIM 会话协商）"
else
	bad "MBIM：wan6 没关，会空转刷日志"
fi

: > "$UCI_LOG"
PATH="$TMP/bin:$PATH" sh -c ". '$TMP/sw.sh'; set_wan wwan0 dhcp" 2>/dev/null
if grep -q 'network.wan.device=wwan0' "$UCI_LOG"; then
	ok "DHCP：wan.device 写的是网卡名 wwan0"
else
	bad "DHCP：wan.device 不对 —— $(grep wan.device "$UCI_LOG" | head -1)"
fi
if grep -q 'network.wan6.proto=dhcpv6' "$UCI_LOG"; then
	ok "DHCP：wan6 走 dhcpv6"
else
	bad "DHCP：wan6 没配成 dhcpv6"
fi

echo
echo "════════════════════════════"
echo "  MBIM 设备参数测试：通过 $PASS 项，失败 $FAIL 项"
[ "$FAIL" -eq 0 ] || exit 1
