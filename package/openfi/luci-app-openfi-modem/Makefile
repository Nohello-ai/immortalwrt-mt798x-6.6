#
# luci-app-openfi-modem —— OpenFi 6C 的 5G 模块信息 + SIM 卡槽切换
#
# 这是一个**独立**的 LuCI 插件，不再往固件自带的 luci-app-openfi / 状态页里塞东西：
#   * 随固件一起编译时，会在 LuCI 里多出一个顶层菜单「移动网络」
#   * 单独编译时，产物是一个 .apk，可以直接装到已经刷好的机器上
#
# 只读查询 + 卡槽切换都走模块自己的 AT 口，AT 读写只用 busybox 的
# stty / timeout / cat，不依赖 sms_tool、picocom、atinout，
# 也不调用 QModem（QModem 的拨号 + 硬件流量卸载有已知重启问题）。
#
include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/package.mk

PKG_NAME:=luci-app-openfi-modem
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=OpenFi 6C community port

LUCI_TITLE:=LuCI app for OpenFi 6C 5G modem info and SIM slot switch
LUCI_DEPENDS:=+kmod-usb-serial-option +kmod-usb-serial-wwan
LUCI_PKGARCH:=all
LUCI_DESCRIPTION:=OpenFi 6C 5G 模块信息查询（只读 AT）与 SIM 卡槽切换（AT+QUIMSLOT）。

# 关掉 luci.mk 的 jsmin：本插件只有几百行 JS，不值得为了省几 KB
# 去冒 minifier 解析失败、整次固件编译中断的风险。
LUCI_MINIFY_JS:=0

define Package/luci-app-openfi-modem/conffiles
/etc/config/openfi_modem
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
