/**
 * matrix-test.mjs — dsh-safe-launch 全版本兼容性矩阵工具（发布闸门）。
 *
 * 用法:
 *   node tools/matrix-test.mjs install <v1,v2,...>   安装各版本运行时并盘点命令面
 *   node tools/matrix-test.mjs probe  <v1,v2,...>    对已安装版本逐个做激活金丝雀
 *   node tools/matrix-test.mjs report                输出矩阵汇总(markdown)
 *
 * 结果写入 tools/matrix/<version>.json 与 tools/matrix/summary.md
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import http from 'node:http';

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RUNTIMES = join(REPO, 'tools', 'matrix', 'runtimes');
const OUT = join(REPO, 'tools', 'matrix');
const PKG = '@deepseek-ai/dsh';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, args, opts = {}) {
	return new Promise((res) => {
		const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) }, cwd: opts.cwd });
		let out = '', err = '';
		c.stdout?.on('data', (d) => { out += d; });
		c.stderr?.on('data', (d) => { err += d; });
		const timer = setTimeout(() => { try { c.kill(); } catch {} }, opts.timeoutMs ?? 600000);
		c.on('close', (code) => { clearTimeout(timer); res({ code: code ?? 1, stdout: out, stderr: err }); });
		c.on('error', (e) => { clearTimeout(timer); res({ code: -1, stdout: out, stderr: String(e) }); });
	});
}
/** 整串命令行经 %ComSpec% 执行（规避 Node 对含引号参数的二次包装） */
function shLine(line, opts = {}) {
	return new Promise((res) => {
		const c = spawn(line, { windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) }, cwd: opts.cwd });
		let out = '', err = '';
		c.stdout?.on('data', (d) => { out += d; });
		c.stderr?.on('data', (d) => { err += d; });
		const timer = setTimeout(() => { try { c.kill(); } catch {} }, opts.timeoutMs ?? 600000);
		c.on('close', (code) => { clearTimeout(timer); res({ code: code ?? 1, stdout: out, stderr: err }); });
		c.on('error', (e) => { clearTimeout(timer); res({ code: -1, stdout: out, stderr: String(e) }); });
	});
}
function httpGet(url, timeoutMs = 2500) {
	return new Promise((res) => {
		const req = http.get(url, { timeout: timeoutMs }, (r) => { r.resume(); res(r.statusCode >= 200 && r.statusCode < 300); });
		req.on('timeout', () => { req.destroy(); res(false); });
		req.on('error', () => res(false));
	});
}
async function waitUp(url, maxSec) {
	const dl = Date.now() + maxSec * 1000;
	while (Date.now() < dl) { if (await httpGet(url)) return true; await sleep(600); }
	return false;
}

async function installVersion(v) {
	const dir = join(RUNTIMES, v);
	mkdirSync(dir, { recursive: true });
	const marker = join(dir, '.installed-ok');
	if (existsSync(marker)) return { v, cached: true };
	console.log(`[install] ${v} ...`);
	const r = await shLine(`pnpm add ${PKG}@${v} --dir "${dir}"`, { timeoutMs: 900000 });
	if (r.code !== 0) return { v, error: 'npm install 失败: ' + (r.stderr || r.stdout).slice(-300) };
	writeFileSync(marker, `ok ${new Date().toISOString()}`);
	return { v, cached: false };
}

function resolveEntry(v) {
	const base = join(RUNTIMES, v, 'node_modules', '@deepseek-ai', 'dsh');
	const pjPath = join(base, 'package.json');
	if (!existsSync(pjPath)) return null;
	const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
	let rel = null;
	if (typeof pj.bin === 'string') rel = pj.bin;
	else if (pj.bin && typeof pj.bin === 'object') rel = Object.values(pj.bin)[0];
	else if (pj.main) rel = pj.main;
	if (rel) { const p = join(base, rel); if (existsSync(p)) return { entry: p, via: `bin:${rel}` }; }
	// 兜底扫描
	const stack = [base];
	while (stack.length) {
		const d = stack.pop();
		for (const f of readdirSync(d)) {
			const fp = join(d, f);
			if (statSync(fp).isDirectory()) stack.push(fp);
			else if (/bin\.js$/i.test(f)) return { entry: fp, via: 'scan' };
		}
	}
	return null;
}

async function inventory(v) {
	const row = { version: v };
	const inst = await installVersion(v);
	if (inst.error) { row.error = inst.error; return row; }
	row.cached = !!inst.cached;
	const e = resolveEntry(v);
	if (!e) { row.error = '无法定位入口 bin'; return row; }
	row.entry = e.entry; row.entryVia = e.via;
	// 内部 @deepseek-ai 层包清单
	const scopeDir = join(RUNTIMES, v, 'node_modules', '@deepseek-ai');
	row.layers = existsSync(scopeDir) ? readdirSync(scopeDir).filter((n) => !n.startsWith('.')) : [];
	// 各层包是否声明 dsh.bundle.patch
	row.bundleLayers = [];
	for (const l of row.layers) {
		try {
			const lpj = JSON.parse(readFileSync(join(scopeDir, l, 'package.json'), 'utf8'));
			if (lpj.dsh?.bundle?.patch || lpj.dsh?.bundles) row.bundleLayers.push(`@deepseek-ai/${l}`);
		} catch {}
	}
	// 命令面探测
	const h = await sh('node.exe', [e.entry, '--help'], { timeoutMs: 60000 });
	row.helpExit = h.code;
	row.helpHead = (h.stdout + '\n' + h.stderr).trim().split('\n').slice(0, 14).join('\n');
	row.helpText = h.stdout + '\n' + h.stderr;
	row.hasProfileFlag = /--profile/i.test(row.helpText);
	const cmdWord = (row.helpText.match(/^\s{2,}(web|serve|start)\b/m) || [])[1] || 'web';
	row.webCmdName = cmdWord;
	// 关键旗标属于启动子命令自己的 help，而非顶层
	const wh = await sh('node.exe', [e.entry, cmdWord, '--help'], { timeoutMs: 60000 });
	const wtext = wh.stdout + '\n' + wh.stderr;
	row.webHelpText = wtext;
	row.hasHostFlag = /--host/i.test(wtext);
	row.hasPortFlag = /--port/i.test(wtext);
	row.hasNoOpen = /--no-open/i.test(wtext);
	row.hasWebCommand = true;
	const ver = await sh('node.exe', [e.entry, '--version'], { timeoutMs: 30000 });
	row.selfVersion = ver.stdout.trim().split('\n')[0] || null;
	const plugHelp = await sh('node.exe', [e.entry, 'plugin', '--profile', 'web', '--help'], { timeoutMs: 60000 });
	row.pluginSubcommand = plugHelp.code === 0 && /add|install/i.test(plugHelp.stdout + plugHelp.stderr);
	const dump = await sh('node.exe', [e.entry, '--profile', 'web', '--dump-config'], { timeoutMs: 60000, env: { DSH_HOME: join(OUT, 'scratch-home') } });
	row.dumpConfigSupported = dump.code === 0;
	writeFileSync(join(OUT, `${v}.inventory.json`), JSON.stringify(row, null, 2));
	console.log(`[inventory] ${v}: entry=${row.entryVia} layers=${row.layers.length} pluginCmd=${row.pluginSubcommand} dump=${row.dumpConfigSupported}`);
	return row;
}

// ---- probe: 在该版本上验证插件激活 ----
async function probe(v) {
	const invPath = join(OUT, `${v}.inventory.json`);
	if (!existsSync(invPath)) { console.log(`[probe] ${v}: 缺 inventory，先跑 install`); return; }
	const inv = JSON.parse(readFileSync(invPath, 'utf8'));
	if (!inv.entry) { console.log(`[probe] ${v}: 无入口，跳过`); return; }
	const iso = join(OUT, 'scratch', `iso-${v.replace(/[^\w.\-]/g, '_')}`);
	mkdirSync(join(iso, 'profiles', 'web'), { recursive: true });
	try {
		// settings 拷贝（若存在）
		const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
		for (const f of ['settings.yaml']) { const s = join(dshHome, f); if (existsSync(s)) { try { writeFileSync(join(iso, f), readFileSync(s)); } catch {} } }
		// 该版本自己的核心层 + 本插件
		const layers = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']; // 固定核心两层：headless 等可选层与 web 栈重叠会 duplicate loader entry 崩溃
		const pkg = {
			name: 'dsh-profile-web', private: true,
			dependencies: { 'dsh-safe-launch': 'file:' + REPO.replace(/\\/g, '/') },
			dsh: { profile: { bundles: [...layers, 'dsh-safe-launch'] } }
		};
		writeFileSync(join(iso, 'profiles', 'web', 'package.json'), JSON.stringify(pkg, null, 2));
		const pa = await shLine(`pnpm --dir "${join(iso, 'profiles', 'web')}" add file:${REPO.replace(/\\/g, '/')}`, { timeoutMs: 600000 });
		if (pa.code !== 0) { console.log(`[probe] ${v}: 插件依赖安装失败 ${pa.code} :: ${(pa.stderr || pa.stdout).trim().split('\n').slice(-3).join(' | ')}`); return; }

		// 按该版本 help 动态构造启动形状候选（只包含它支持的旗标）
		const port = '34170';
		const cmdWord = inv.hasWebCommand || 'web';
		const base = inv.hasProfileFlag ? ['--profile', 'web'] : [cmdWord];
		const hostPart = inv.hasHostFlag ? ['--host', '127.0.0.1'] : [];
		const portPart = inv.hasPortFlag ? ['--port', port] : [];
		const noOpen = inv.hasNoOpen ? ['--no-open'] : [];
		const cands = [
			[...base, ...hostPart, ...portPart, ...noOpen],
			[...base, ...portPart, ...noOpen],
			...(inv.hasProfileFlag ? [[cmdWord, ...hostPart, ...portPart, ...noOpen]] : []),
			[...base]
		];
		let worked = null, pingRes = null, lastErr = '';
		for (const args of cands) {
			const child = spawn('node.exe', [inv.entry, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO, env: { ...process.env, DSH_HOME: iso } });
			let out = '', err = '';
			child.stdout?.on('data', (d) => { out += d; });
			child.stderr?.on('data', (d) => { err += d; });
			const up = await waitUp(`http://127.0.0.1:${port}/`, 45);
			if (up) {
				worked = args.join(' ');
				pingRes = await new Promise((res) => {
					const req = http.get(`http://127.0.0.1:${port}/dsh-safe-launch/ping`, { timeout: 5000 }, (r) => {
						let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b.slice(0, 200)));
					});
					req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); });
				});
				try { child.kill(); } catch {}
				await sleep(1500);
				break;
			}
			lastErr = (err + '\n' + out).trim().split('\n').slice(-4).join(' | ');
			writeFileSync(join(OUT, v + '.boot.log'), '[args] ' + args.join(' ') + '\n--- stdout ---\n' + out + '\n--- stderr ---\n' + err);
			try { child.kill(); } catch {}
			await sleep(1200);
		}
		const row = { version: v, bootCmd: worked, ping: pingRes, lastBootError: worked ? '' : lastErr };
		writeFileSync(join(OUT, `${v}.probe.json`), JSON.stringify(row, null, 2));
		console.log(`[probe] ${v}: boot="${worked}" ping=${pingRes ? 'OK' : '无路由'}${worked ? '' : ' err=' + lastErr.slice(0, 120)}`);
	} finally {
		try { rmSyncDir(iso); } catch {}
	}
}

function rmSyncDir(dir) {
	rmSync(dir, { recursive: true, force: true });
}

const cmd = process.argv[2];
const versions = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
mkdirSync(OUT, { recursive: true });
if (cmd === 'install') {
	for (const v of versions) { const r = await inventory(v); if (r.error) console.log(`!! ${v}: ${r.error}`); }
} else if (cmd === 'probe') {
	for (const v of versions) await probe(v);
} else if (cmd === 'report') {
	const rows = [];
	const inst = JSON.parse(readFileSync(join(OUT, 'installability.json'), 'utf8'));
	for (const { version } of inst.filter((x) => x.installable)) {
		const inv = existsSync(join(OUT, `${version}.inventory.json`)) ? JSON.parse(readFileSync(join(OUT, `${version}.inventory.json`), 'utf8')) : {};
		const prb = existsSync(join(OUT, `${version}.probe.json`)) ? JSON.parse(readFileSync(join(OUT, `${version}.probe.json`), 'utf8')) : {};
		rows.push({
			version,
			bootCmd: prb.bootCmd || (inv.hasProfileFlag ? '(--profile 形状待验证)' : '?'),
			pluginActivated: Boolean(prb.ping && /dormant|version/.test(prb.ping)),
			ping: prb.ping || '',
			pluginSubcommand: inv.pluginSubcommand ?? null,
			dumpConfig: inv.dumpConfigSupported ?? null
		});
	}
	let md = '# dsh-safe-launch × dsh 历史版本兼容性矩阵\n\n';
	md += `生成时间: ${new Date().toISOString()}\n\n`;
	md += '| dsh 版本 | 验证通过的启动命令 | 插件激活 | plugin 子命令 | dump-config |\n|---|---|---|---|---|\n';
	for (const r of rows) {
		md += `| ${r.version} | \`${r.bootCmd}\` | ${r.pluginActivated ? '✓' : '✗'} | ${r.pluginSubcommand ? '✓' : '✗/无'} | ${r.dumpConfig ? '✓' : '✗(预检自动跳过)'} |\n`;
	}
	writeFileSync(join(OUT, 'summary.md'), md);
	console.log(md);
} else {
	console.log('用法: install|probe|report <versions>');
}
