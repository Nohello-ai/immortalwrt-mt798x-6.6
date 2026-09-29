# luci-app-openfi-modem

OpenFi 6C 的 **独立** LuCI 插件：5G 模块信息 + SIM 卡槽切换。

## 为什么是独立插件

之前那份实现把 Modem Info 直接塞进了 `luci-app-openfi` 的状态页
（`htdocs/.../view/status/include/15_modem.js`），那样有几个问题：

- 必须重刷整个固件才能改一行显示
- 和厂商自带插件、状态页耦合，升级底座时容易被覆盖
- 想装到已经刷好的机器上没门

现在改成独立的 `luci-app-openfi-modem`：

- 随固件编译时，LuCI 里多出一个顶层菜单 **移动网络**
- 单独编译时，产物是一个 `.apk`，可以直接装到已经刷好的机器上（不用重刷固件）

## 页面内容

顶层菜单 **移动网络 → 模组信息与卡槽**：

| 分组 | 内容 |
| --- | --- |
| 模组信息 | 设备型号、厂商、模块固件、IMEI、AT 串口、SIM 状态、当前卡槽、支持卡槽、运营商、网络制式、信号（CSQ / dBm / RSRP）、模块温度 |
| SIM 卡槽 | 切到其它卡槽（`AT+QUIMSLOT=n`）、软重启模块（`AT+CFUN=1,1`）、手动刷新 |

## 实现要点

- **只读优先**：信息查询只发 `ATI` / `AT+xxx?` 这类查询指令，
  一条写指令都不发，所以刷新页面不会打断模块当前的数据连接。
- **不依赖额外软件包**：只用 busybox 的 `stty` / `timeout` / `cat`。
  不需要 `sms_tool`、`picocom`、`atinout`。
- **不调用 QModem**：QModem 的「拨号 + 硬件流量卸载」组合会把机器搞重启
  （FUjr/QModem discussions #214），本插件只用 AT 口读状态和切卡。
- **串口读法**：`stty ... min 0 time 5` 之后，串口空闲 0.5 秒 `read()` 返回 0，
  `cat` 当作 EOF 自然退出。比「后台 `cat` + `sleep` + `kill`」那种写法
  更不容易漏数据，也不会留下僵尸进程。
- **AT 口自动探测**：先按 `uci openfi_modem.modem.at_port`，再按 sysfs 里的
  接口名（移远模组是 `Quectel USB AT Port`），最后按 `ttyUSB3..0` 顺序兜底。

## 文件

```
Makefile
htdocs/luci-static/resources/view/openfi/modem.js   # 页面
root/etc/config/openfi_modem                        # uci 配置（AT 口 / 波特率 / 刷新间隔）
root/usr/lib/openfi-modem/at.sh                     # AT 串口公共函数
root/usr/sbin/openfi-modem-info                     # 只读查询，输出 JSON
root/usr/sbin/openfi-modem-switch                   # 切卡 / 软重启
root/usr/share/luci/menu.d/luci-app-openfi-modem.json
root/usr/share/rpcd/acl.d/luci-app-openfi-modem.json
```

## 配置

`/etc/config/openfi_modem`

```
config modem 'modem'
	option at_port ''      # 留空 = 自动探测
	option baud '115200'

config switch 'switch'
	option restart_after_switch '0'   # 切完卡是否自动软重启模块

config view 'view'
	option poll '15'       # 页面自动刷新间隔（秒）
```

## 命令行排障

```sh
openfi-modem-info            # 看 JSON
openfi-modem-info --raw      # 看 AT 口和模块原始回显
openfi-modem-switch 2        # 切到 SIM 2
openfi-modem-switch restart  # 软重启模块
```

## 已知限制

- 双卡单待：同一时刻只有一张卡在线，切卡要重新搜网。
- 模块必须处在能通过 DHCP 上网的 USB 模式（ECM / RNDIS），
  本插件不会去改模块的 USB 模式，也不负责拨号。
- `AT+QTEMP` / `AT+QRSRP` / `AT+QNWINFO` 是移远（含展锐平台）的私有指令，
  换其它厂商模组时这几项会为空，其余字段仍可用。
