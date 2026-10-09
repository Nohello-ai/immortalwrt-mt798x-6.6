'use strict';
'require view';
'require ui';

/*
 * 这个页面被【故意停用】了。
 *
 * 原因：在 MT7981 + 闭源 mt_wifi 驱动上，打开这个页面会触发全信道扫描，
 * 而扫描路径会让设备【整机重启】（内核 panic / 硬件看门狗复位），
 * 且重启后什么日志都不留。上游一直没修。
 *
 * 扫描本身的调用链是：
 *     channel_analysis.js
 *       -> ubus iwinfo.scan / iwinfo.freqlist
 *       -> libiwinfo 的 wext 后端
 *       -> ioctl(SIOCSIWSCAN)
 *       -> mt_wifi 的 ap_iw_handler
 *       -> 扫描引擎 -> 加密/大整数运算代码里的 panic()
 *
 * 所以这里换成一个静态说明页，不调用任何 iwinfo RPC。
 * 要看当前信道/信号，用【状态 → 无线】或者 MTK 自己的无线页面。
 */

return view.extend({
	render: function () {
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Channel Analysis') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				E('p', {}, [
					_('This page has been disabled on this device.')
				]),
				E('p', {}, [
					_('Reason: opening it triggers a full channel scan, and on this ' +
					  'hardware (MT7981 + the closed-source mt_wifi driver) the scan path ' +
					  'can reset the whole device. No crash log is left behind, which is ' +
					  'why it is disabled rather than fixed here.')
				]),
				E('p', {}, [
					_('To check the current channel and signal strength, use ' +
					  'Status → Wireless instead.')
				])
			])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
