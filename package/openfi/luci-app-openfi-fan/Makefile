#
# luci-app-openfi-fan —— OpenFi 6C 散热风扇管理
#
# 把风扇控制从厂商那套里拆成独立包：
#   * /usr/sbin/openfi-fan 常驻守护，按四点温度曲线驱动两路反向 25 kHz PWM
#   * LuCI 页面改曲线/模式/保护阈值，保存后给守护进程发 SIGHUP 热重载，风扇不中断
#
# 只依赖 busybox 的 sh/awk/pgrep，不需要 lm-sensors、不需要额外 daemon。
#
include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/package.mk

PKG_NAME:=luci-app-openfi-fan
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=OpenFi 6C community port

LUCI_TITLE:=LuCI app for OpenFi 6C fan control
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all
LUCI_DESCRIPTION:=OpenFi 6C 风扇管理：四点温度曲线、手动转速、最低转速、紧急全速、采样周期。
LUCI_MINIFY_JS:=0

define Package/luci-app-openfi-fan/conffiles
/etc/config/openfi
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
