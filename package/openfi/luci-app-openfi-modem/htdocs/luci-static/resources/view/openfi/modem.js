'use strict';
'require view';
'require fs';
'require poll';
'require ui';

/*
 * OpenFi 6C「移动网络」页面
 *
 * 数据全部来自 /usr/sbin/openfi-modem-info（只读 AT 查询），
 * 卡槽切换 / 软重启走 /usr/sbin/openfi-modem-switch。
 * 不依赖 QModem，也不碰固件自带的 luci-app-openfi。
 */

var INFO_CMD   = '/usr/sbin/openfi-modem-info';
var SWITCH_CMD = '/usr/sbin/openfi-modem-switch';
var POLL_SECS  = 15;

function dash(v) {
	return (v === undefined || v === null || v === '') ? '—' : String(v);
}

function replaceChildren(node, children) {
	while (node.firstChild)
		node.removeChild(node.firstChild);

	for (var i = 0; i < children.length; i++)
		node.appendChild(children[i]);
}

function infoRow(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '35%' }, label),
		E('td', { 'class': 'td left' }, dash(value))
	]);
}

function notify(text, kind) {
	if (typeof ui.addNotification === 'function')
		return ui.addNotification(null, E('p', {}, text), kind || 'info');

	ui.showModal(_('提示'), [
		E('p', {}, text),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('关闭'))
		])
	]);
}

return view.extend({
	/* 本页没有表单，不要底部的 Save / Save & Apply / Reset */
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load: function() {
		return this.fetchInfo();
	},

	fetchInfo: function() {
		return fs.exec(INFO_CMD, []).then(function(res) {
			try {
				return JSON.parse((res && res.stdout) || '{}') || {};
			}
			catch (e) {
				return { error: _('返回内容不是合法 JSON') };
			}
		}).catch(function(e) {
			return { error: String((e && e.message) || e) };
		});
	},

	render: function(data) {
		var self = this;

		this.tbody   = E('tbody');
		this.slotBox = E('div');

		var node = E('div', {}, [
			E('h2', {}, _('移动网络')),
			E('div', { 'class': 'cbi-map-descr' },
				_('通过 5G 模块的 AT 口读取状态，只发查询指令，不会打断当前的数据连接。')),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('模组信息')),
				E('table', { 'class': 'table' }, [ this.tbody ])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('SIM 卡槽')),
				E('div', { 'class': 'cbi-section-descr' },
					_('切换用 AT+QUIMSLOT=n。本机是双卡单待，切换后模块要重新搜网，移动网络会中断几十秒。')),
				this.slotBox
			])
		]);

		this.paint(data);

		poll.add(function() {
			return self.fetchInfo().then(function(d) { self.paint(d); });
		}, POLL_SECS);

		return node;
	},

	paint: function(d) {
		this.data = d || {};

		replaceChildren(this.tbody, this.infoRows(this.data));
		replaceChildren(this.slotBox, this.slotControls(this.data));
	},

	infoRows: function(d) {
		var signal = dash(d.csq);

		if (d.csq !== undefined && d.csq !== '' && d.csq !== '99') {
			signal = _('CSQ %s').format(d.csq);

			if (d.dbm !== undefined && d.dbm !== '')
				signal += ' / ' + d.dbm + ' dBm';
		}

		if (d.rsrp !== undefined && d.rsrp !== '')
			signal += ' / RSRP ' + d.rsrp + ' dBm';

		var slots = (d.sim_slots && d.sim_slots.length)
			? d.sim_slots.join(' / ') : '';

		var rows = [
			infoRow(_('设备型号'), d.model),
			infoRow(_('厂商'), d.manufacturer),
			infoRow(_('模块固件'), d.revision),
			infoRow(_('IMEI'), d.imei),
			infoRow(_('AT 串口'), d.at_port),
			infoRow(_('SIM 状态'), d.sim_status),
			infoRow(_('当前卡槽'), d.sim_slot ? ('SIM ' + d.sim_slot) : ''),
			infoRow(_('支持卡槽'), slots),
			infoRow(_('运营商'), d.operator),
			infoRow(_('网络制式'), d.network),
			infoRow(_('信号'), signal),
			infoRow(_('模块温度'), d.temperature !== undefined && d.temperature !== ''
				? d.temperature + ' °C' : '')
		];

		if (d.error)
			rows.push(infoRow(_('错误'), d.error));

		return rows;
	},

	slotControls: function(d) {
		var self = this;
		var cur = d.sim_slot ? String(d.sim_slot) : '';
		var slots = (d.sim_slots && d.sim_slots.length)
			? d.sim_slots.map(String) : [ '1', '2' ];

		var others = slots.filter(function(s) { return s !== cur; });
		if (!others.length)
			others = [ '1', '2' ].filter(function(s) { return s !== cur; });

		var nodes = [
			E('p', {}, _('当前卡槽：%s').format(cur ? ('SIM ' + cur) : _('未知')))
		];

		others.forEach(function(slot) {
			nodes.push(E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) { self.askSwitch(ev, slot); }
			}, _('切换到 SIM %s').format(slot)));
		});

		nodes.push(E('button', {
			'class': 'btn cbi-button cbi-button-reset',
			'click': function(ev) { self.askRestart(ev); }
		}, _('软重启模块')));

		nodes.push(E('button', {
			'class': 'btn cbi-button',
			'click': function(ev) {
				ev.preventDefault();
				self.fetchInfo().then(function(info) { self.paint(info); });
			}
		}, _('刷新')));

		return nodes;
	},

	askSwitch: function(ev, slot) {
		var self = this;
		ev.preventDefault();

		ui.showModal(_('切换 SIM 卡槽'), [
			E('p', {}, _('确定要切换到 SIM %s 吗？').format(slot)),
			E('p', { 'class': 'cbi-section-descr' },
				_('切换后模块会重新搜网，移动网络会中断几十秒。')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('取消')),
				E('button', {
					'class': 'btn cbi-button cbi-button-positive important',
					'click': function() {
						ui.hideModal();
						self.run([ String(slot) ],
							_('正在切换到 SIM %s…').format(slot),
							_('已下发切换到 SIM %s').format(slot));
					}
				}, _('确定切换'))
			])
		]);
	},

	askRestart: function(ev) {
		var self = this;
		ev.preventDefault();

		ui.showModal(_('软重启 5G 模块'), [
			E('p', {}, _('确定要软重启 5G 模块吗？（AT+CFUN=1,1）')),
			E('p', { 'class': 'cbi-section-descr' },
				_('模块会重新枚举 USB，移动网络中断约 30–60 秒。')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('取消')),
				E('button', {
					'class': 'btn cbi-button cbi-button-negative important',
					'click': function() {
						ui.hideModal();
						self.run([ 'restart' ], _('正在重启模块…'), _('重启指令已下发'));
					}
				}, _('确定重启'))
			])
		]);
	},

	run: function(args, busyText, okText) {
		var self = this;

		ui.showModal(_('请稍候'), [
			E('p', { 'class': 'spinning' }, busyText)
		]);

		return fs.exec(SWITCH_CMD, args).then(function(res) {
			ui.hideModal();

			var r = {};
			try { r = JSON.parse((res && res.stdout) || '{}') || {}; }
			catch (e) { r = {}; }

			if (r.ok)
				notify(okText, 'info');
			else
				notify(_('操作失败：%s').format(dash(r.error || r.response)), 'error');

			return self.fetchInfo().then(function(info) { self.paint(info); });
		}).catch(function(e) {
			ui.hideModal();
			notify(_('操作失败：%s').format(String((e && e.message) || e)), 'error');
		});
	}
});
