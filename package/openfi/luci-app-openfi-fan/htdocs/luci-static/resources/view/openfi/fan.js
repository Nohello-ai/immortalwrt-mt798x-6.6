'use strict';
'require view';
'require form';
'require fs';
'require poll';
'require uci';
'require ui';

/*
 * OpenFi 6C「散热」页面
 *
 *  · 实时状态、曲线预览都取自 /usr/sbin/openfi-fan-status（只读），5 秒刷新
 *  · 表单改的是 UCI openfi.fan.*，保存后给守护进程发 SIGHUP 热重载，风扇不中断
 *  · 图表用 createElementNS 手建 SVG，描边/文字一律 currentColor，跟随主题配色
 *  · 布局只用 LuCI 标准 class（cbi-section / table / btn），不写死任何颜色
 */

var STATUS_CMD = '/usr/sbin/openfi-fan-status';
var POLL_SECS  = 5;
var SVG_NS     = 'http://www.w3.org/2000/svg';

function dash(v) {
	return (v === undefined || v === null || v === '') ? '—' : String(v);
}

function num(v, dflt) {
	var n = parseInt(v, 10);
	return isNaN(n) ? dflt : n;
}

function replaceChildren(node, children) {
	while (node.firstChild)
		node.removeChild(node.firstChild);

	for (var i = 0; i < children.length; i++)
		node.appendChild(children[i]);
}

/* ---- SVG 小工具（不走 E()，避免命名空间问题）---- */
function svgEl(tag, attr, children) {
	var n = document.createElementNS(SVG_NS, tag);

	for (var k in (attr || {}))
		if (Object.prototype.hasOwnProperty.call(attr, k))
			n.setAttribute(k, attr[k]);

	(children || []).forEach(function(c) { n.appendChild(c); });

	return n;
}

function svgText(x, y, text, extra) {
	var attr = {
		'x': x, 'y': y,
		'font-size': '11',
		'fill': 'currentColor',
		'text-anchor': 'middle'
	};

	for (var k in (extra || {}))
		attr[k] = extra[k];

	var n = svgEl('text', attr, []);
	n.textContent = text;
	return n;
}

/* ---- 状态行 ---- */
function statusRow(label, value, cls) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '38%' }, label),
		E('td', { 'class': 'td left' + (cls ? ' ' + cls : '') }, dash(value))
	]);
}

function reasonText(r) {
	switch (r) {
	case 'auto':         return _('自动（跟随曲线）');
	case 'manual':       return _('手动（固定转速）');
	case 'overheat':     return _('过热，全速');
	case 'sensor_fault': return _('温度传感器异常，全速');
	case 'starting':     return _('启动助推（全速 1 秒）');
	case 'pwm_fault':    return _('PWM 异常，正在重试');
	case 'stopped':      return _('已停止（退出时置全速）');
	default:             return dash(r);
	}
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('openfi'),
			this.fetchStatus()
		]).then(function(r) { return r[1]; });
	},

	fetchStatus: function() {
		return fs.exec(STATUS_CMD, []).then(function(res) {
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
		this.chartBody  = E('div');

		var statusSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('实时状态')),
			this.statusBody
		]);

		var chartSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('曲线与当前温度')),
			E('div', { 'class': 'cbi-section-descr' },
				_('横轴温度、纵轴转速。虚线是当前 CPU 温度，用它看风扇此刻落在曲线哪一段。')),
			this.chartBody
		]);

		/* ---------------- 表单 ---------------- */
		var m = new form.Map('openfi', _('散热风扇'),
			_('按温度曲线自动调速。改完点「保存并应用」——守护进程会热重载，风扇不中断。'));

		var opts = {};

		/* 工作模式 */
		var s1 = m.section(form.NamedSection, 'fan', 'fan', _('工作模式'));
		s1.anonymous = true;
		s1.addremove = false;

		var o = s1.option(form.ListValue, 'mode', _('控制模式'),
			_('自动＝按下面四点曲线调速；手动＝固定转速，绕过曲线。'));
		o.value('auto', _('自动（温度曲线）'));
		o.value('manual', _('手动（固定转速）'));
		o.default = 'auto';

		o = s1.option(form.Value, 'manual_speed', _('手动转速'),
			_('百分比。0 表示停转，请谨慎使用。'));
		o.datatype = 'range(0,100)';
		o.depends('mode', 'manual');
		o.default = '55';

		o = s1.option(form.Value, 'period', _('采样周期'),
			_('秒（2–30）。越短反应越快，也越费电。'));
		o.datatype = 'range(2,30)';
		o.default = '5';

		/* 四点曲线 */
		var s2 = m.section(form.NamedSection, 'fan', 'fan', _('四点温度曲线'));
		s2.anonymous = true;
		s2.addremove = false;
		s2.description = _('温度逐点递增（相邻至少差 2°C），转速也逐点递增。低于第 1 点且允许停转时风扇停转。');

		for (var i = 1; i <= 4; i++) {
			opts['temp' + i] = s2.option(form.Value, 'temp' + i,
				_('第 %d 点 · 温度 (°C)').format(i));
			opts['temp' + i].datatype = 'range(20,95)';
			opts['temp' + i].default = String(55 + (i - 1) * 3);
			opts['temp' + i].rmempty = false;

			opts['speed' + i] = s2.option(form.Value, 'speed' + i,
				_('第 %d 点 · 转速 (%%)').format(i));
			opts['speed' + i].datatype = 'range(0,100)';
			opts['speed' + i].default = String([ 5, 36, 68, 100 ][i - 1]);
			opts['speed' + i].rmempty = false;
		}

		/* 保护与限制 */
		var s3 = m.section(form.NamedSection, 'fan', 'fan', _('保护与限制'));
		s3.anonymous = true;
		s3.addremove = false;

		var minOpt = s3.option(form.Value, 'min_speed', _('最低转速'),
			_('百分比。自动模式下除了停转，不会低于这个值。'));
		minOpt.datatype = 'range(5,100)';
		minOpt.default = '5';

		var emgOpt = s3.option(form.Value, 'emergency_temp', _('紧急全速温度'),
			_('℃。达到就直接全速，不看曲线。必须比第 4 点高至少 2°C。'));
		emgOpt.datatype = 'range(60,100)';
		emgOpt.default = '85';

		var stopOpt = s3.option(form.Flag, 'fan_stop', _('低温时允许停转'),
			_('开：低于第 1 点时停转（安静）；关：至少保持最低转速（持续气流）。'));
		stopOpt.default = '1';
		stopOpt.enabled = '1';
		stopOpt.disabled = '0';

		/* ---- 交叉校验（读的是表单当前值，含未保存的改动）---- */
		function curveError() {
			var t = [], sp = [], k;

			for (k = 1; k <= 4; k++) {
				t.push(num(opts['temp' + k].formvalue('fan'), NaN));
				sp.push(num(opts['speed' + k].formvalue('fan'), NaN));
			}

			for (k = 1; k < 4; k++) {
				if (!(t[k] >= t[k - 1] + 2))
					return _('温度必须逐点递增：第 %d 点至少要比第 %d 点高 2°C').format(k + 1, k);

				if (!(sp[k] >= sp[k - 1]))
					return _('转速必须逐点递增：第 %d 点不能低于第 %d 点').format(k + 1, k);
			}

			if (sp[0] < num(minOpt.formvalue('fan'), 5))
				return _('第 1 点转速不能低于最低转速');

			if (!(num(emgOpt.formvalue('fan'), 85) >= t[3] + 2))
				return _('紧急全速温度要比第 4 点至少高 2°C');

			return null;
		}

		[ opts.temp1, opts.temp2, opts.temp3, opts.temp4,
		  opts.speed1, opts.speed2, opts.speed3, opts.speed4,
		  minOpt, emgOpt ].forEach(function(opt) {
			var base = opt.validate;

			opt.validate = function(section_id, value) {
				if (typeof base === 'function') {
					var r = base.call(this, section_id, value);
					if (r !== true)
						return r;
				}

				return curveError() || true;
			};
		});

		return m.render().then(function(formNode) {
			poll.add(function() {
				return self.fetchStatus().then(function(d) { self.paint(d); });
			}, POLL_SECS);

			self.paint(data);

			return E('div', {}, [ statusSection, chartSection, formNode ]);
		});
	},

	paint: function(d) {
		this.data = d || {};

		replaceChildren(this.statusBody, [ this.statusTable(this.data) ]);
		replaceChildren(this.chartBody,  [ this.chart(this.data) ]);
	},

	statusTable: function(d) {
		var dm = d.daemon || {};
		var pwm = d.pwm || [];
		var rows = [];
		var pwmTxt = [];

		for (var i = 0; i < pwm.length; i++) {
			var p = pwm[i] || {};
			pwmTxt.push(_('通道 %d：%s，转速 %s%%').format(
				num(p.channel, i),
				(p.enable == 1) ? _('已启用') : _('未启用'),
				dash(p.speed)));
		}

		rows.push(statusRow(_('守护进程'),
			d.running ? _('运行中') : _('未运行（配置仍会保存）')));

		if (d.error)
			rows.push(statusRow(_('错误'), d.error));

		rows.push(statusRow(_('当前状态'), reasonText(dm.reason)));
		rows.push(statusRow(_('CPU 温度'), (dm.cpu === null || dm.cpu === undefined) ? '—' : dm.cpu + ' °C'));
		rows.push(statusRow(_('风扇输出'), (dm.output === null || dm.output === undefined) ? '—' : dm.output + ' %'));
		rows.push(statusRow(_('目标转速'), (dm.target === null || dm.target === undefined) ? '—' : dm.target + ' %'));
		rows.push(statusRow(_('模式'), (dm.mode === 'manual') ? _('手动') : _('自动')));
		rows.push(statusRow(_('PWM'), pwmTxt.join('　') || '—'));
		rows.push(statusRow(_('状态更新时间'),
			dm.updated ? new Date(dm.updated * 1000).toLocaleTimeString() : '—'));

		return E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ]);
	},

	/* 曲线图：数据取「实际生效」的配置，所以保存并应用后会自动跟着变 */
	chart: function(d) {
		var cfg = d.config || {};
		var dm  = d.daemon || {};

		var t = [
			num(cfg.temp1, 55), num(cfg.temp2, 58),
			num(cfg.temp3, 61), num(cfg.temp4, 65)
		];
		var sp = [
			num(cfg.speed1, 5), num(cfg.speed2, 36),
			num(cfg.speed3, 68), num(cfg.speed4, 100)
		];
		var emg = num(cfg.emergency_temp, 85);
		var cpu = (dm.cpu === null || dm.cpu === undefined) ? null : num(dm.cpu, null);

		var W = 460, H = 190;
		var padL = 42, padR = 14, padT = 14, padB = 30;
		var minT = Math.min(t[0] - 5, cpu === null ? t[0] - 5 : cpu - 2);
		var maxT = Math.max(t[3] + 5, emg, cpu === null ? t[3] : cpu + 2);
		var spanT = Math.max(maxT - minT, 1);

		function px(temp) {
			return padL + (temp - minT) * (W - padL - padR) / spanT;
		}
		function py(speed) {
			return padT + (100 - speed) * (H - padT - padB) / 100;
		}

		var g = [];

		/* 网格与刻度 */
		[ 0, 25, 50, 75, 100 ].forEach(function(v) {
			g.push(svgEl('line', {
				'x1': padL, 'y1': py(v), 'x2': W - padR, 'y2': py(v),
				'stroke': 'currentColor', 'stroke-width': '0.5', 'opacity': '0.25'
			}));
			g.push(svgText(padL - 6, py(v) + 3, v + '%', { 'text-anchor': 'end' }));
		});

		/* 坐标轴 */
		g.push(svgEl('line', {
			'x1': padL, 'y1': padT, 'x2': padL, 'y2': H - padB,
			'stroke': 'currentColor', 'stroke-width': '1'
		}));
		g.push(svgEl('line', {
			'x1': padL, 'y1': H - padB, 'x2': W - padR, 'y2': H - padB,
			'stroke': 'currentColor', 'stroke-width': '1'
		}));

		/* 取整温度刻度，避免出现 57.5 这种 */
		var step = Math.max(1, Math.round(spanT / 6));
		for (var tick = Math.ceil(minT / step) * step; tick <= maxT; tick += step) {
			g.push(svgText(px(tick), H - padB + 14, tick + '°', {}));
		}

		/* 紧急温度参考线 */
		g.push(svgEl('line', {
			'x1': px(emg), 'y1': padT, 'x2': px(emg), 'y2': H - padB,
			'stroke': 'currentColor', 'stroke-width': '1', 'stroke-dasharray': '3 3',
			'opacity': '0.6'
		}));
		g.push(svgText(px(emg), padT + 9, _('紧急') + ' ' + emg + '°', { 'font-size': '10' }));

		/* 曲线：先水平到 t1，再折线经过 4 点 */
		var pts = [ [ px(minT), py(sp[0]) ] ];
		for (var k = 0; k < 4; k++)
			pts.push([ px(t[k]), py(sp[k]) ]);

		g.push(svgEl('polyline', {
			'points': pts.map(function(p) { return p[0] + ',' + p[1]; }).join(' '),
			'fill': 'none', 'stroke': 'currentColor', 'stroke-width': '2',
			'stroke-linejoin': 'round'
		}));

		/* 四个折点 */
		for (k = 0; k < 4; k++) {
			g.push(svgEl('circle', {
				'cx': px(t[k]), 'cy': py(sp[k]), 'r': '3',
				'fill': 'currentColor'
			}));
			g.push(svgText(px(t[k]), py(sp[k]) - 7, t[k] + '°/' + sp[k] + '%', { 'font-size': '10' }));
		}

		/* 当前温度标记 */
		if (cpu !== null) {
			g.push(svgEl('line', {
				'x1': px(cpu), 'y1': padT, 'x2': px(cpu), 'y2': H - padB,
				'stroke': 'currentColor', 'stroke-width': '1.5', 'stroke-dasharray': '4 2'
			}));
			g.push(svgText(px(cpu), H - padB + 27, _('当前') + ' ' + cpu + '°', { 'font-size': '10' }));
		}

		/* 轴标题 */
		g.push(svgText(W - padR, padT + 10, _('转速 %'), { 'text-anchor': 'end', 'font-size': '10' }));
		g.push(svgText((padL + W - padR) / 2, H - 3, _('温度 °C'), { 'font-size': '10' }));

		return svgEl('svg', {
			'viewBox': '0 0 ' + W + ' ' + H,
			'width': '100%',
			'style': 'max-width:560px;height:auto',
			'role': 'img',
			'aria-label': _('风扇温度曲线')
		}, g);
	}
});
