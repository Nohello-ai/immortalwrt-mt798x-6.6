#!/bin/sh
#
# 回归测试：确认「信道分析」这条会崩设备的路径【真的是关掉的】。
#
# 背景：在 MT7981 + 闭源 mt_wifi 上，打开信道分析会触发全信道扫描，
# 扫描路径会让整机重启（panic / 看门狗复位），且重启后不留日志。
# 上游没修，我们的办法是在 files/ 里覆盖菜单和页面把它停用。
#
# 这个测试的目的：以后谁再动 files/ 或换 LuCI 版本时，
# 如果覆盖失效了（比如菜单项又冒出来），CI 要立刻发现，
# 而不是等用户点一下把设备搞重启。
#
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

MENU="$ROOT/files/usr/share/luci/menu.d/luci-mod-status.json"
PAGE="$ROOT/files/www/luci-static/resources/view/status/channel_analysis.js"

pass=0; fail=0
ok()  { printf '    ✅ %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '    ❌ %s\n' "$1"; fail=$((fail+1)); }

echo "  ── 菜单覆盖 ──"

[ -f "$MENU" ] && ok "菜单覆盖文件存在" || bad "菜单覆盖文件不存在：$MENU"

if [ -f "$MENU" ]; then
	# 1. 必须是合法 JSON
	if python3 -c "import json,sys; json.load(open('$MENU'))" 2>/dev/null; then
		ok "菜单覆盖是合法 JSON"
	else
		bad "菜单覆盖不是合法 JSON —— 整个状态菜单都会挂掉"
	fi

	# 2. 【关键】不能有 channel_analysis
	if grep -q 'admin/status/channel_analysis' "$MENU"; then
		bad "菜单里还有 admin/status/channel_analysis —— 覆盖失效了！"
	else
		ok "菜单里没有 channel_analysis（已隐藏）"
	fi

	# 3. 但其它状态页必须还在，别把整个菜单写空了
	for k in admin/status/overview admin/status/routes admin/status/logs \
	         admin/status/processes admin/status/realtime; do
		if grep -q "\"$k\"" "$MENU"; then
			ok "保留了 $k"
		else
			bad "把 $k 也弄丢了 —— 覆盖文件写坏了"
		fi
	done

	# 4. 顺带确认：原厂那份里【确实有】这一项
	#    （如果原厂哪天删了，我们的覆盖就没必要了，也该知道）
	if command -v unsquashfs >/dev/null 2>&1; then
		: # 需要固件镜像才有意义，CI 里没有，跳过
	fi
fi

echo "  ── 页面 stub ──"

[ -f "$PAGE" ] && ok "页面 stub 存在" || bad "页面 stub 不存在：$PAGE"

if [ -f "$PAGE" ]; then
	# 【关键】先剥掉注释，只留真正的代码再检查 ——
	# 注释里出现 "scan"/"iwinfo" 是在解释原因，无害；
	# 代码里出现就说明真的会去调扫描，那才是问题。
	CODE="$(python3 - "$PAGE" <<'PYEOF'
import re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read()
s=re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)   # 块注释
s=re.sub(r'//[^\n]*', ' ', s)                 # 行注释
sys.stdout.write(s)
PYEOF
)"

	if printf '%s' "$CODE" | grep -q 'getScanList'; then
		bad "代码里出现了 getScanList —— 会触发扫描，必须去掉"
	else
		ok "代码里没有 getScanList"
	fi

	if printf '%s' "$CODE" | grep -q 'iwinfo'; then
		bad "代码里出现了 iwinfo RPC —— 会触发扫描，必须去掉"
	else
		ok "代码里没有 iwinfo RPC 调用"
	fi

	if printf '%s' "$CODE" | grep -qiE "'scan'|\"scan\"|\.scan\("; then
		bad "代码里出现了 scan 调用 —— 必须去掉"
	else
		ok "代码里没有 scan 调用"
	fi

	# stub 必须导出 view
	if grep -q 'view.extend' "$PAGE"; then
		ok "stub 是一个合法的 LuCI view"
	else
		bad "stub 没有 view.extend —— 打开页面会白屏/报错"
	fi

	# stub 应该是静态页：不许 require rpc / 不许 poll
	if printf '%s' "$CODE" | grep -qE "require 'rpc'|require \"rpc\""; then
		bad "stub 里 require 了 rpc —— 静态页不需要，去掉更安全"
	else
		ok "stub 没有 require rpc"
	fi
	if printf '%s' "$CODE" | grep -qE "require 'poll'|poll\.add"; then
		bad "stub 里用了 poll —— 会反复刷新，去掉"
	else
		ok "stub 没有用 poll"
	fi
fi

echo "  ── git 跟踪（.gitignore 有 /files，漏加就白干）──"

if command -v git >/dev/null 2>&1 && [ -d "$ROOT/.git" ]; then
	for f in "files/usr/share/luci/menu.d/luci-mod-status.json" \
	         "files/www/luci-static/resources/view/status/channel_analysis.js"; do
		if git -C "$ROOT" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
			ok "已进 git：$f"
		else
			bad "没进 git（被 .gitignore 的 /files 挡了，要用 git add -f）：$f"
		fi
	done
fi

echo
echo "════════════════════════════════════"
printf '  WiFi 扫描停用检查：通过 %s 项，失败 %s 项\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
