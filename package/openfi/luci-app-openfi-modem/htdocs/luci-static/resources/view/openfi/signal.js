'use strict';
'require view';
'require fs';
'require poll';
'require ui';

/*
 * OpenFi 6C「信号与流量」页面
 *
 *  · 曲线数据来自 /usr/sbin/openfi-modem-signal（读 /tmp 里的环缓冲，不碰 AT 口）
 *  · 连接与流量来自 /usr/sbin/openfi-modem-link（ifstatus + sysfs 统计）
 *  · 实时速率在**页面侧**算：拿相邻两次采样的差值除以时间差，
 *    设备侧不存任何状态，刷新页面也不会跳变
 *  · SVG 用 currentColor 描边/文字，跟随主题；没有自定义 CSS
 */

var SIGNAL_CMD = '/usr/sbin/openfi-modem-signal';
var LINK_CMD   = '/usr/sbin/openfi-modem-link';
var POLL_SECS  = 5;
var SVG_NS     = 'http://www.w3.org/2000/svg';

var SERIES = [
	{ id: 'csq',  label: 'CSQ',  unit: '',     min: 0,    max: 31,   get: function(s) { return s.csq; } },
	{ id: 'rsrp', label: 'RSRP', unit: ' dBm', min: -140, max: -60,  get: function(s) { return s.rsrp; } },
	{ id: 'dbm',  label: 'RSSI', unit: ' dBm', min: -113, max: -51,  get: function(s) { return s.dbm; } }
];

function dash(v) {
	return (v === undefined || v === null || v === '') ? '—' : String(v);
}

function num(v) {
	var n = Number(v);
	return (v === null || v === undefined || v === '' || isNaN(n)) ? null : n;
}

function replaceChildren(node, children) {
	while (node.firstChild)
		node.removeChild(node.firstChild);

	for (var i = 0; i < children.length; i++)
		node.appendChild(children[i]);
}

function fmtBytes(n) {
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], i = 0, v = num(n);

	if (v === null)
		return '—';

	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}

	return v.toFixed(i === 0 ? 0 : (v < 10 ? 2 : 1)) + ' ' + u[i];
}

function fmtRate(bytesPerSec) {
	if (bytesPerSec === null)
		return '—';

	return fmtBytes(bytesPerSec) + '/s';
}

function fmtUptime(sec) {
	var s = num(sec);

	if (s === null)
		return '—';

	var d = Math.floor(s / 86400),
	    h = Math.floor((s % 86400) / 3600),
	    m = Math.floor((s % 3600) / 60);

	if (d > 0) return _('%d 天 %d 小时').format(d, h);
	if (h > 0) return _('%d 小时 %d 分').format(h, m);
	if (m > 0) return _('%d 分 %d 秒').format(m, Math.floor(s % 60));

	return _('%d 秒').format(Math.floor(s));
}

function fmtTime(epoch) {
	var t = num(epoch);

	return (t === null) ? '—' : new Date(t * 1000).toLocaleTimeString();
}

/* ---- SVG 小工具 ---- */
function svgEl(tag, attr, children) {
	var n = document.createElementNS(SVG_NS, tag);

	for (var k in (attr || {}))
		if (Object.prototype.hasOwnProperty.call(attr, k))
			n.setAttribute(k, attr[k]);

	(children || []).forEach(function(c) { n.appendChild(c); });

	return n;
}

function svgText(x, y, text, extra) {
	var attr = { 'x': x, 'y': y, 'font-size': '11', 'fill': 'currentColor', 'text-anchor': 'middle' };

	for (var k in (extra || {}))
		attr[k] = extra[k];

	var n = svgEl('text', attr, []);
	n.textContent = text;
	return n;
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '32%' }, label),
		E('td', { 'class': 'td left' }, dash(value))
	]);
}

return view.extend({
	load: function() {
		var self = this;

		this.series = 'csq';

		return Promise.all([
			this.fetchSignal(),
			this.fetchLink()
		]).then(function(r) {
			return { signal: r[0], link: r[1] };
		});
	},

	fetchSignal: function() {
		return fs.exec(SIGNAL_CMD, []).then(function(res) {
			try { return JSON.parse((res && res.stdout) || '{}') || {}; }
			catch (e) { return { error: _('信号历史不是合法 JSON') }; }
		}).catch(function(e) {
			return { error: String((e && e.message) || e) };
		});
	},

	fetchLink: function() {
		return fs.exec(LINK_CMD, []).then(function(res) {
			try { return JSON.parse((res && res.stdout) || '{}') || {}; }
			catch (e) { return { error: _('连接状态不是合法 JSON') }; }
		}).catch(function(e) {
			return { error: String((e && e.message) || e) };
		});
	},

	render: function(data) {
		var self = this;

		this.chartBody  = E('div');
		this.legendBody = E('div');
		this.linkBody   = E('div');
		this.flowBody   = E('div');
		this.seriesBox  = E('div', { 'class': 'cbi-section-descr' });

		this.signal = (data && data.signal) || {};
		this.link   = (data && data.link) || {};

		var chartSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('信号历史')),
			this.seriesBox,
			this.chartBody,
			this.legendBody
		]);

		var linkSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('连接状态')),
			this.linkBody
		]);

		var flowSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('流量统计')),
			E('div', { 'class': 'cbi-section-descr' },
				_('速率由本页相邻两次采样算得，设备侧不存状态。累计值从模组网口挂载起算。')),
			this.flowBody
		]);

		this.paint(data);

		poll.add(function() {
			return Promise.all([ self.fetchSignal(), self.fetchLink() ])
				.then(function(r) { self.paint({ signal: r[0], link: r[1] }); });
		}, POLL_SECS);

		return E('div', {}, [ chartSection, linkSection, flowSection ]);
	},

	paint: function(d) {
		var link = (d && d.link) || {};
		var prev = this.prevLink;

		/* 实时速率：相邻两次采样差值 / 时间差 */
		if (prev && link.t && prev.t && link.t > prev.t) {
			var dt = link.t - prev.t;
			var rx = num(link.rx_bytes), tx = num(link.tx_bytes);

			this.rate = {
				rx: (rx !== null && prev.rx !== null) ? Math.max(0, (rx - prev.rx) / dt) : null,
				tx: (tx !== null && prev.tx !== null) ? Math.max(0, (tx - prev.tx) / dt) : null
			};
		}

		if (link.t && num(link.rx_bytes) !== null)
			this.prevLink = { t: link.t, rx: num(link.rx_bytes), tx: num(link.tx_bytes) };

		this.signal = (d && d.signal) || {};
		this.link = link;

		replaceChildren(this.seriesBox, [ this.seriesButtons() ]);
		replaceChildren(this.chartBody, [ this.chart(this.signal) ]);
		replaceChildren(this.legendBody, [ this.legend(this.signal) ]);
		replaceChildren(this.linkBody, [ this.linkTable(this.link) ]);
		replaceChildren(this.flowBody, [ this.flowTable(this.link) ]);
	},

	seriesButtons: function() {
		var self = this;
		var nodes = [ E('span', {}, _('曲线数据：')) ];

		SERIES.forEach(function(s) {
			nodes.push(E('button', {
				'class': 'btn cbi-button' + (self.series === s.id ? ' cbi-button-positive' : ''),
				'style': 'margin:0 .25em',
				'click': function(ev) {
					ev.preventDefault();
					self.series = s.id;
					replaceChildren(self.seriesBox, [ self.seriesButtons() ]);
					replaceChildren(self.chartBody, [ self.chart(self.signal) ]);
					replaceChildren(self.legendBody, [ self.legend(self.signal) ]);
				}
			}, s.label));
		});

		return E('div', {}, nodes);
	},

	legend: function(sig) {
		var samples = (sig.samples || []).filter(function(s) { return true; });
		var def = SERIES.filter(function(s) { return s.id === this.series; }.bind(this))[0] || SERIES[0];
		var vals = samples.map(function(s) { return num(def.get(s)); })
			.filter(function(v) { return v !== null; });

		if (!vals.length)
			return E('p', { 'class': 'cbi-section-descr' },
				_('还没有采样数据。采样间隔 %s 秒，等一会儿就有了。').format(dash(sig.interval)));

		var min = Math.min.apply(null, vals),
		    max = Math.max.apply(null, vals),
		    sum = vals.reduce(function(a, b) { return a + b; }, 0);

		return E('p', { 'class': 'cbi-section-descr' }, [
			_('样本 %d 个（每 %s 秒一个）　').format(samples.length, dash(sig.interval)),
			_('当前 %s%s　').format(vals[vals.length - 1], def.unit),
			_('最小 %s%s　').format(min, def.unit),
			_('最大 %s%s　').format(max, def.unit),
			_('平均 %s%s').format((sum / vals.length).toFixed(1), def.unit)
		]);
	},

	chart: function(sig) {
		var samples = sig.samples || [];
		var def = SERIES.filter(function(s) { return s.id === this.series; }.bind(this))[0] || SERIES[0];

		var W = 640, H = 200, padL = 46, padR = 12, padT = 12, padB = 28;

		var pts = [];

		samples.forEach(function(s, i) {
			var v = num(def.get(s));
			if (v !== null)
				pts.push({ i: i, t: num(s.t), v: v, net: s.network });
		});

		if (pts.length < 2) {
			var empty = svgEl('svg', {
				'viewBox': '0 0 ' + W + ' ' + H, 'width': '100%',
				'style': 'max-width:100%;height:auto'
			}, [
				svgEl('line', {
					'x1': padL, 'y1': H - padB, 'x2': W - padR, 'y2': H - padB,
					'stroke': 'currentColor', 'stroke-width': '1'
				}),
				svgEl('line', {
					'x1': padL, 'y1': padT, 'x2': padL, 'y2': H - padB,
					'stroke': 'currentColor', 'stroke-width': '1'
				}),
				svgText(W / 2, H / 2, _('样本不够，画不出曲线'), { 'font-size': '13' })
			]);

			return empty;
		}

		/* 取值域：固定量程和实测范围取并集，太窄就撑开，避免曲线被放大成噪声 */
		var lo = def.min, hi = def.max;
		var vals = pts.map(function(p) { return p.v; });
		var dmin = Math.min.apply(null, vals), dmax = Math.max.apply(null, vals);
		var span = Math.max(hi - lo, 1);

		lo = Math.min(lo, Math.floor(dmin - span * 0.1));
		hi = Math.max(hi, Math.ceil(dmax + span * 0.1));

		if (hi - lo < span * 0.2) {
			var mid = (hi + lo) / 2;
			lo = mid - span * 0.1;
			hi = mid + span * 0.1;
		}

		function px(i) { return padL + i * (W - padL - padR) / Math.max(samples.length - 1, 1); }
		function py(v) { return padT + (hi - v) * (H - padT - padB) / Math.max(hi - lo, 1); }

		var g = [];

		/* 横向网格 + 刻度 */
		[ 0, 0.25, 0.5, 0.75, 1 ].forEach(function(f) {
			var v = lo + (hi - lo) * (1 - f);

			g.push(svgEl('line', {
				'x1': padL, 'y1': padT + f * (H - padT - padB),
				'x2': W - padR, 'y2': padT + f * (H - padT - padB),
				'stroke': 'currentColor', 'stroke-width': '0.5', 'opacity': '0.25'
			}));
			g.push(svgText(padL - 6, padT + f * (H - padT - padB) + 3,
				(Math.round(v * 10) / 10) + '', { 'text-anchor': 'end' }));
		});

		/* 轴 */
		g.push(svgEl('line', {
			'x1': padL, 'y1': padT, 'x2': padL, 'y2': H - padB,
			'stroke': 'currentColor', 'stroke-width': '1'
		}));
		g.push(svgEl('line', {
			'x1': padL, 'y1': H - padB, 'x2': W - padR, 'y2': H - padB,
			'stroke': 'currentColor', 'stroke-width': '1'
		}));

		/* 折线 */
		g.push(svgEl('polyline', {
			'points': pts.map(function(p) { return px(p.i) + ',' + py(p.v); }).join(' '),
			'fill': 'none', 'stroke': 'currentColor', 'stroke-width': '2',
			'stroke-linejoin': 'round'
		}));

		/* 最后一个点标个圆点 */
		var last = pts[pts.length - 1];
		g.push(svgEl('circle', { 'cx': px(last.i), 'cy': py(last.v), 'r': '3', 'fill': 'currentColor' }));

		/* 时间轴：首/中/尾 */
		var t0 = samples[0].t, t1 = samples[samples.length - 1].t;

		if (t0 && t1) {
			[ 0, 0.5, 1 ].forEach(function(f) {
				var idx = Math.round((samples.length - 1) * f);
				var tt = num(samples[idx].t);

				if (tt === null)
					return;

				var d = new Date(tt * 1000);
				g.push(svgText(px(idx), H - padB + 15,
					('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2), {}));
			});
		}

		g.push(svgText(W - padR, padT + 10, def.label + def.unit, { 'text-anchor': 'end', 'font-size': '10' }));

		return svgEl('svg', {
			'viewBox': '0 0 ' + W + ' ' + H,
			'width': '100%',
			'style': 'max-width:100%;height:auto',
			'role': 'img',
			'aria-label': _('信号历史曲线')
		}, g);
	},

	linkTable: function(link) {
		if (link.error)
			return E('p', { 'class': 'cbi-section-descr' }, _('读取失败：') + link.error);

		var rows = [
			row(_('网口'), link.device),
			row(_('接口状态'), link.up ? _('已连接') : _('未连接')),
			row(_('协议'), link.proto),
			row(_('已连接时长'), fmtUptime(link.uptime)),
			row(_('IP 地址'), (link.ipv4 && link.ipv4.length) ? link.ipv4.join('　') : ''),
			row(_('默认网关'), link.gw),
			row(_('DNS'), (link.dns && link.dns.length) ? link.dns.join('　') : '')
		];

		return E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ]);
	},

	flowTable: function(link) {
		if (link.error)
			return E('p', { 'class': 'cbi-section-descr' }, _('读取失败：') + link.error);

		var rate = this.rate || { rx: null, tx: null };

		var rows = [
			row(_('累计接收'), fmtBytes(link.rx_bytes)),
			row(_('累计发送'), fmtBytes(link.tx_bytes)),
			row(_('实时接收'), fmtRate(rate.rx)),
			row(_('实时发送'), fmtRate(rate.tx)),
			row(_('采样时刻'), fmtTime(link.t))
		];

		return E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ]);
	}
});
