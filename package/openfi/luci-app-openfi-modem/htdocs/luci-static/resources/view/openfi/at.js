'use strict';
'require view';
'require fs';
'require ui';

/*
 * OpenFi 6C「AT 终端」页面
 *
 *  · 后端 /usr/sbin/openfi-modem-at：单行、限长、黑名单过滤后发给模组
 *  · 黑名单挡的是会造成失联/变砖的指令（USB 模式切换、fastboot、
 *    固件升级、恢复出厂、EFS 操作）—— 这些发错要拆机才能救
 *  · 历史只存在浏览器里（刷新即清），设备侧不落盘
 *  · 输出面板只用布局类内联样式（等宽/可滚动），没有颜色，跟随主题
 */

var AT_CMD = '/usr/sbin/openfi-modem-at';
var MAX_HISTORY = 20;

var QUICK = [
	'ATI',
	'AT+CSQ',
	'AT+CESQ',
	'AT+QRSRP',
	'AT+QNWINFO',
	'AT+CREG?',
	'AT+CEREG?',
	'AT+COPS?',
	'AT+CPIN?',
	'AT+CGSN',
	'AT+QCCID',
	'AT+CIMI',
	'AT+QCAINFO',
	'AT+QTEMP'
];

function msg(r) {
	if (!r)
		return _('没有返回');

	if (r.error)
		return r.error;

	return _('已发送');
}

return view.extend({
	load: function() {
		return {};
	},

	render: function() {
		var self = this;

		this.history = [];

		this.input = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'spellcheck': 'false',
			'autocomplete': 'off',
			'placeholder': 'AT+CSQ',
			'style': 'width:100%;font-family:monospace',
			'keydown': function(ev) {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					self.send(self.input.value);
				}
			}
		});

		this.sendBtn = E('button', {
			'class': 'btn cbi-button cbi-button-action important',
			'click': function(ev) { ev.preventDefault(); self.send(self.input.value); }
		}, _('发送'));

		this.resultBox = E('div');

		this.quickBox = E('div', { 'style': 'margin:.5em 0' });

		QUICK.forEach(function(cmd) {
			self.quickBox.appendChild(E('button', {
				'class': 'btn cbi-button',
				'style': 'margin:0 .25em .4em 0;font-family:monospace',
				'click': function(ev) {
					ev.preventDefault();
					self.input.value = cmd;
					self.send(cmd);
				}
			}, cmd));
		});

		this.historyBox = E('div');

		return E('div', {}, [
			E('h2', {}, _('AT 终端')),
			E('div', { 'class': 'cbi-map-descr' },
				_('直接对 5G 模组的 AT 口发指令。只发你想发的，读指令不会打断数据连接。')),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('发送指令')),
				E('div', { 'class': 'cbi-section-descr' },
					_('会造成失联或变砖的指令已被后端拦下：USB 模式切换（AT+QCFG="usbnet"）、fastboot、固件升级、恢复出厂（AT+QRST / AT&F）、EFS 操作。这些发错要拆机才能救。')),
				E('div', { 'style': 'display:flex;gap:.5em;align-items:center' }, [
					E('div', { 'style': 'flex:1' }, [ this.input ]),
					this.sendBtn
				]),
				this.quickBox
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('本次结果')),
				this.resultBox
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('历史（仅保存在本浏览器，刷新即清）')),
				this.historyBox
			])
		]);
	},

	send: function(cmd) {
		var self = this;

		cmd = (cmd || '').replace(/^\s+|\s+$/g, '');

		if (!cmd) {
			this.showResult({ ok: false, cmd: '', error: _('请输入指令') }, '');
			return Promise.resolve();
		}

		this.sendBtn.disabled = true;
		this.showBusy(cmd);

		return fs.exec(AT_CMD, [ cmd ]).then(function(res) {
			var r = {};

			try { r = JSON.parse((res && res.stdout) || '{}') || {}; }
			catch (e) { r = { ok: false, cmd: cmd, error: _('后端返回的不是合法 JSON') }; }

			self.sendBtn.disabled = false;
			self.showResult(r, cmd);
			self.pushHistory(r, cmd);
			self.input.value = '';
		}).catch(function(e) {
			self.sendBtn.disabled = false;
			self.showResult({ ok: false, cmd: cmd, error: String((e && e.message) || e) }, cmd);
		});
	},

	showBusy: function(cmd) {
		while (this.resultBox.firstChild)
			this.resultBox.removeChild(this.resultBox.firstChild);

		this.resultBox.appendChild(E('p', { 'class': 'spinning' },
			_('正在发送 %s …').format(cmd)));
	},

	showResult: function(r, cmd) {
		while (this.resultBox.firstChild)
			this.resultBox.removeChild(this.resultBox.firstChild);

		var kind = r.ok ? _('成功') : _('失败');

		this.resultBox.appendChild(E('p', {},
			_('指令：%s　结果：%s').format(cmd || r.cmd || '—', kind)));

		if (r.error)
			this.resultBox.appendChild(E('p', { 'class': 'alert-message error' }, r.error));

		if (r.reply)
			this.resultBox.appendChild(E('pre', {
				'class': 'cbi-input-textarea',
				'style': 'white-space:pre-wrap;word-break:break-all;max-height:340px;overflow:auto;margin:0'
			}, r.reply));
	},

	pushHistory: function(r, cmd) {
		this.history.unshift({ cmd: cmd, reply: r.reply || '', error: r.error || '', ok: r.ok });

		if (this.history.length > MAX_HISTORY)
			this.history.length = MAX_HISTORY;

		this.paintHistory();
	},

	paintHistory: function() {
		var self = this;
		var nodes = [];

		if (!this.history.length) {
			nodes.push(E('p', { 'class': 'cbi-section-descr' }, _('还没有发送过指令。')));
		}

		this.history.forEach(function(h) {
			var t = '';

			nodes.push(E('div', { 'style': 'margin-bottom:.75em' }, [
				E('div', { 'style': 'font-family:monospace;font-weight:bold' },
					'> ' + h.cmd + (h.error ? ('　[' + h.error + ']') : '')),
				E('pre', {
					'class': 'cbi-input-textarea',
					'style': 'white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;margin:.25em 0 0'
				}, h.reply || _('（无输出）'))
			]));
		});

		while (this.historyBox.firstChild)
			this.historyBox.removeChild(this.historyBox.firstChild);

		nodes.forEach(function(n) { self.historyBox.appendChild(n); });
	}
});
