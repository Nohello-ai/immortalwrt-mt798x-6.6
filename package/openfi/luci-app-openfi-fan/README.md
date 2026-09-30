# luci-app-openfi-fan

OpenFi 6C 的**散热风扇 + 状态灯管理**。独立包，跟厂商那套 `luci-app-openfi` 解耦。
菜单是顶层 **散热与灯光**，下面两页：**风扇控制** 和 **状态灯**。

## 为什么独立

厂商把风扇塞在 `luci-app-openfi` 里，跟 LED、拨动开关、产测混在一个包，改一行要重刷整个固件。
这里拆出来：

- **守护进程**：`/usr/sbin/openfi-fan`（常驻，procd 托管，挂了自动拉起）
- **LuCI 页面**：顶层菜单 **散热与灯光** →「风扇控制」/「状态灯」
- **状态灯**：`/usr/sbin/openfi-led`，不需要常驻进程，开机和保存配置时各跑一次
- 页面保存后给守护进程发 **SIGHUP 热重载** —— 风扇不中断，不用重启服务

## 硬件特性（决定了实现方式）

这块板子两路 PWM 是**反向**的，25 kHz：

| duty_cycle | 实际转速 |
|---|---|
| `0` | **全速** |
| `40000`（=100%） | 停转 |

所以代码里 `speed` 是正常的"速度百分比"，写 PWM 时换算成 `duty = 40000 * (100 - speed) / 100`。

设备树里 `pwm-fan` 节点已置 `disabled` —— 两路 PWM 由本包的守护进程独占
（`/sys/class/pwm/pwmchip0/pwm0` + `pwm1`），交给内核 pwm-fan 驱动会互相抢。

## 控制逻辑

- **四点温度曲线**：`temp1..temp4` → `speed1..speed4`，中间线性插值
- **最低转速** `min_speed`：自动模式下不会低于它
- **停转** `fan_stop`：开＝低于第 1 点停转；关＝至少保持最低转速
- **紧急全速** `emergency_temp`：达到就直接 100%，不看曲线
- **手动模式** `mode=manual`：固定 `manual_speed`，绕过曲线
- **缓升急降**：升速立刻执行，降速每个采样最多降 10 个百分点
- **启动助推**：从停转状态启动时先全速 1 秒，保证风扇能转起来
- **传感器故障**：读不到 CPU 温度就全速（安全侧）
- **PWM 初始化重试**：失败每 5 秒重试，并把原因写进状态

## 页面

- **实时状态**（5 秒刷新）：守护进程、当前状态/原因、CPU 温度、风扇输出、目标转速、两路 PWM 实况、状态更新时间
- **状态灯页**：实时表格（每盏灯的当前 trigger / 亮灭 / 配置）+ 总开关 + 四盏灯三态设置
- **曲线与当前温度**：手绘 SVG。横轴温度、纵轴转速，画四个折点 + 紧急温度虚线 + **当前温度竖虚线**，一眼看出风扇此刻落在曲线哪一段
- **表单**：工作模式 / 四点温度曲线 / 保护与限制

### 关于"跟随主题"

- 布局只用 LuCI 标准 class（`cbi-section` / `table` / `btn`），**不写死任何颜色**
- SVG 的描边和文字一律 `currentColor` → 自动用当前主题的文字色
- 没有任何自定义 CSS 文件，所以 bootstrap / argon / material 等主题都能正常显示

### 校验

- 单字段范围：温度 20–95℃、转速 0–100%、周期 2–30 秒
- 交叉校验（读表单当前值，含未保存的改动）：
  - 温度逐点递增，相邻至少差 2℃
  - 转速逐点递增
  - 第 1 点转速 ≥ 最低转速
  - 紧急温度 ≥ 第 4 点 + 2℃
- 即使页面校验被绕过，**守护进程自己也会校验**（`valid_curve`），不合格就退回默认曲线并记日志 —— 不会出现"风扇不转"的危险状态

## UCI

`/etc/config/openfi`：

```
config fan 'fan'
	option mode 'auto'          # auto | manual
	option period '5'           # 秒，2–30
	option min_speed '5'        # %
	option manual_speed '55'    # %
	option emergency_temp '85'  # ℃
	option fan_stop '1'         # 低温停转
	option temp1 '55'
	option temp2 '58'
	option temp3 '61'
	option temp4 '65'
	option speed1 '5'
	option speed2 '36'
	option speed3 '68'
	option speed4 '100'

config led 'led'
	option enabled '1'          # 0 = 四盏灯全灭（夜间模式）
	option system 'on'          # on 常亮 / off 常灭 / keep 不干预
	option internet 'on'
	option wifi 'on'
	option modem 'on'
```

命令行改完记得重载：`/etc/init.d/openfi-fan reload`（风扇热重载 + 灯光重新应用）

## 状态灯

设备树里四盏灯都是**普通 GPIO**，而且**没有 `default-trigger`** —— 开机默认全灭，
必须由 `openfi-led` 驱动。这跟厂商那套 `op_led.sh` 做的事一样（它就循环调
`apply_hardware`），但我们不需要 2 秒一次的守护循环：**开机跑一次 + 保存配置时跑一次**就够。

| 设置 | 行为 |
|---|---|
| 常亮 | `trigger=none`、`brightness=1` |
| 常灭 | `trigger=none`、`brightness=0` |
| 不干预 | 完全不动它，交回内核或别的程序（例如 `/etc/config/system` 的 `led` 段） |

总开关关掉 = 四盏灯全灭（夜间模式），忽略每盏灯的设置。

## 依赖

只有 `luci-base` + busybox（`sh` / `awk` / `pgrep`）。
**不需要** `lm-sensors`，**不需要**额外守护进程，也不碰 QModem。

## 状态查询

```sh
/usr/sbin/openfi-fan-status      # 一行 JSON：running / daemon / pwm / config
```

实测（无 PWM 硬件的机器上）：

```json
{"running":false,"daemon":null,
 "pwm":[{"channel":0,"enable":null,"duty":null,"period":null,"speed":null}, …],
 "config":{"mode":"auto","period":5,"min_speed":5, …}}
```
