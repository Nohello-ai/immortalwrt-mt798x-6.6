'use strict';
'require view';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';

/*
 * OpenFi 6C「状态灯」页面
 *
 *  · 四盏灯是普通 GPIO、设备树里没有 default-trigger —— 开机默认全灭，
 *    必须由 /usr/sbin/openfi-led 驱动
 *  · 状态取自 /usr/sbin/openfi-led status（只读），5 秒刷新
 *  · 表单改的是 UCI openfi.led.*，保存后由 procd 的 config.change 触发
 *    /etc/init.d/openfi-fan reload → 重新 apply（见 init.d 里的
 *    procd_add_reload_trigger openfi）
 *  · 布局只用 LuCI 标准 class，没有自定义 CSS/颜色，跟随主题
 */

var STATUS_CMD = '/usr/sbin/openfi-led';
var POLL_SECS  = 5;

var LED_TITLE = {
	system:   _('系统灯'),
	internet: _('外网灯'),
	wifi:     _('无线灯'),
	modem:    _('模组灯')
};

function dash(v) {
	return (v === undefined || v === null || v === '') ? '—' : String(v);
}

function replaceChildren(node, children) {
	while (node.firstChild)
		node.removeChild(node.firstChild);

	for (var i = 0; i < children.length; i++)
		node.appendChild(children[i]);
}

function modeText(m) {
	switch (m) {
	case 'on':   return _('常亮');
	case 'off':  return _('常灭');
	case 'keep': return _('不干预');
	default:     return dash(m);
	}
}

function statusRow(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '30%' }, label),
		E('td', { 'class': 'td left' }, dash(value))
	]);
}

function ledRow(led) {
	var name = led.name || '';
	var bright;

	if (!led.exists)
		bright = _('不存在');
	else if (led.brightness === null || led.brightness === undefined)
		bright = '—';
	else
		bright = (Number(led.brightness) > 0) ? _('亮') : _('灭');

	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left' }, LED_TITLE[name] || name),
		E('td', { 'class': 'td left' }, name),
		E('td', { 'class': 'td left' }, led.exists ? dash(led.trigger) : '—'),
		E('td', { 'class': 'td left' }, bright),
		E('td', { 'class': 'td left' }, modeText(led.mode))
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('openfi'),
			this.fetchStatus()
		]).then(function(r) { return r[1]; });
	},

	fetchStatus: function() {
		return fs.exec(STATUS_CMD, [ 'status' ]).then(function(res) {
			try {
				return JSON.parse((res && res.stdout) || '{}') || {};
			}
			catch (e) {
				return { error: _('状态脚本返回的不是合法 JSON') };
			}
		}).catch(function(e) {
			return { error: String((e && e.message) || e) };
		});
	},

	render: function(data) {
		var self = this;

		this.statusBody = E('div');

		var statusSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('实时状态')),
			E('div', { 'class': 'cbi-section-descr' },
				_('「当前触发器」是内核里这盏灯实际挂的 trigger。下面选了「常亮/常灭」时它会被置成 none，由我们直接控制亮度。')),
			this.statusBody
		]);

		var m = new form.Map('openfi', _('状态灯'),
			_('四盏状态灯分别是系统/外网/无线/模组。保存并应用后会立即生效，不需要重启。'));

		var s1 = m.section(form.NamedSection, 'led', 'led', _('总开关'));
		s1.anonymous = true;
		s1.addremove = false;

		var o = s1.option(form.Flag, 'enabled', _('启用灯光控制'),
			_('关掉＝四盏灯全部熄灭（夜间模式）。此时下面每盏灯的设置会被忽略。'));
		o.default = '1';
		o.enabled = '1';
		o.disabled = '0';

		var s2 = m.section(form.NamedSection, 'led', 'led', _('状态灯'));
		s2.anonymous = true;
		s2.addremove = false;
		s2.description = _('「不干预」表示完全不动这盏灯，把它交回内核或别的程序（例如 /etc/config/system 里的 led 段）。');

		[ 'system', 'internet', 'wifi', 'modem' ].forEach(function(name) {
			var opt = s2.option(form.ListValue, name,
				LED_TITLE[name] + '（' + name + '）');

			opt.value('on',   _('常亮'));
			opt.value('off',  _('常灭'));
			opt.value('keep', _('不干预'));
			opt.default = 'on';
		});

		return m.render().then(function(formNode) {
			poll.add(function() {
				return self.fetchStatus().then(function(d) { self.paint(d); });
			}, POLL_SECS);

			self.paint(data);

			return E('div', {}, [ statusSection, formNode ]);
		});
	},

	paint: function(d) {
		this.data = d || {};

		replaceChildren(this.statusBody, [ this.statusTable(this.data) ]);
	},

	statusTable: function(d) {
		var rows = [];
		var leds = d.leds || [];
		var head = E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('灯')),
			E('th', { 'class': 'th' }, _('硬件名')),
			E('th', { 'class': 'th' }, _('当前触发器')),
			E('th', { 'class': 'th' }, _('当前')),
			E('th', { 'class': 'th' }, _('配置'))
		]);

		rows.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'colspan': '4' }, _('灯光总开关')),
			E('td', { 'class': 'td left' },
				(d.enabled === 0 || d.enabled === '0') ? _('关闭（全灭）') : _('开启'))
		]));

		if (d.error)
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'colspan': '5' }, _('错误：') + d.error)
			]));

		for (var i = 0; i < leds.length; i++)
			rows.push(ledRow(leds[i]));

		if (!leds.length)
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'colspan': '5' }, '—')
			]));

		return E('table', { 'class': 'table' }, [
			E('thead', {}, [ head ]),
			E('tbody', {}, rows)
		]);
	}
});
