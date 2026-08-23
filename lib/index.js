/**
 * dsh-safe-launch — host half.
 *
 * Safe launcher / updater / compatibility-checked plugin installer for DSH.
 * All operations reuse the "last good" boot config stored in
 * `$DSH_HOME/safe-launch/last-good.json` (shared with the PowerShell
 * desktop launcher):
 *
 *   GET/POST /dsh-safe-launch/ping          -> liveness + package info
 *   POST /dsh-safe-launch/status            {} -> saved config summary (+network opt-in)
 *   POST /dsh-safe-launch/check             {} -> detect core/plugin updates, change nothing
 *   POST /dsh-safe-launch/test-candidate    {version?} -> install + canary-test + promote
 *   POST /dsh-safe-launch/install-plugin    {source} -> compatibility-checked plugin install
 *   POST /dsh-safe-launch/update-plugins    {} -> backup/update/canary/commit-or-rollback
 *   POST /dsh-safe-launch/restart           {} -> detached graceful restart (user-invoked)
 *   POST /dsh-safe-launch/rollback-config   {} -> restore previous last-good config (+profile manifests)
 *   POST /dsh-safe-launch/manifest/status   {} -> manifest baseline vs current drift report
 *   POST /dsh-safe-launch/manifest/verify   {} -> canary-verify CURRENT set, adopt or flag
 *   POST /dsh-safe-launch/manifest/ack      {} -> accept current manifests WITHOUT testing (audited)
 *   POST /dsh-safe-launch/job               {id} -> poll a running job
 *
 * Manifest watchdog (v0.1.1): every verified-good state snapshots the profile
 * manifests (package.json / pnpm-lock.yaml / cordis.patch.yml) under
 * `safe-launch/profile-snapshots/` and records a baseline fingerprint
 * (deps + bundles + lockfile hash) inside last-good.json. A 5s watchdog loop
 * detects out-of-band profile edits (direct pnpm/dsh-plugin usage bypassing
 * this plugin): unauthorized changes are audited (`safe-launch/audit.jsonl`),
 * noticed, and automatically canary-verified on a junctioned isolated boot;
 * pass adopts the change into the verified-good snapshot, failure raises a
 * loud warning with rollback guidance.
 *
 * Long operations return `{ ok, jobId }` immediately; poll via /job.
 *
 * Compatibility-checked plugin install (the core promise): the requested
 * plugin is installed into an ISOLATED throwaway profile (temp DSH_HOME,
 * copied manifests + node_modules), booted on a random free port against the
 * current last-good dsh runtime, and only when that boots clean is the plugin
 * installed into the real profile via the official `dsh plugin add`
 * reconciliation. The live instance is never touched during testing.
 *
 * Auto-clean note (per project rules, stated in Chinese in README): the temp
 * isolation homes (`%TEMP%\dsh-canary-*`) and failed candidate runtime dirs
 * are deleted automatically after each run; they are throwaway copies.
 */
import { readFile, writeFile, mkdir, rm, readdir, copyFile, symlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';

const PKG_NAME = 'dsh-safe-launch';
const PKG_VERSION = '0.1.1';
const DSH_PACKAGE = '@deepseek-ai/dsh';

const DSH_HOME = resolve(
	process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
);
const SL_DIR = join(DSH_HOME, 'safe-launch');
const RUNTIME_DIR = join(SL_DIR, 'runtime');
const BACKUP_DIR = join(SL_DIR, 'backups');
const LOGS_DIR = join(SL_DIR, 'logs');
const CONFIG_PATH = join(SL_DIR, 'last-good.json');
const NOTICE_PATH = join(SL_DIR, 'NOTICE.txt');
const PLUGIN_LOG = join(LOGS_DIR, 'plugin.log');
const SNAPSHOTS_DIR = join(SL_DIR, 'profile-snapshots');
const AUDIT_PATH = join(SL_DIR, 'audit.jsonl');
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => {
	const d = new Date();
	const p = (n, w = 2) => String(n).padStart(w, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function ensureDir(dir) {
	await mkdir(dir, { recursive: true });
	return dir;
}

async function readJsonFile(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return null;
	}
}

async function writeText(path, text) {
	await ensureDir(dirname(path));
	await writeFile(path, text, 'utf8');
}

async function appendNotice(message) {
	const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${message}`;
	try {
		await appendFileSafe(NOTICE_PATH, line + '\n');
	} catch {}
}

async function appendFileSafe(path, text) {
	const { appendFile } = await import('node:fs/promises');
	await ensureDir(dirname(path));
	await appendFile(path, text, 'utf8');
}

function logLine(message) {
	const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${message}`;
	console.log(`[${PKG_NAME}] ${message}`);
	appendFileSafe(PLUGIN_LOG, line + '\n').catch(() => {});
}

/** Semver compare supporting prerelease tags; returns -1/0/1 (a<b / = / a>b). */
function cmpSemver(a, b) {
	if (!a || !b) return 0;
	if (a === b) return 0;
	const coreA = a.split('+')[0];
	const coreB = b.split('+')[0];
	const [ca, ra = ''] = coreA.split('-');
	const [cb, rb = ''] = coreB.split('-');
	const na = ca.split('.');
	const nb = cb.split('.');
	for (let i = 0; i < 3; i++) {
		const x = parseInt(na[i] || '0', 10) || 0;
		const y = parseInt(nb[i] || '0', 10) || 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	if (!ra && rb) return 1;
	if (ra && !rb) return -1;
	if (!ra && !rb) return 0;
	const ia = ra.split('.');
	const ib = rb.split('.');
	for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
		const sa = ia[i] ?? '';
		const sb = ib[i] ?? '';
		const va = /^\d+$/.test(sa);
		const vb = /^\d+$/.test(sb);
		if (va && vb) {
			const d = parseInt(sa, 10) - parseInt(sb, 10);
			if (d) return d < 0 ? -1 : 1;
		} else if (va && !vb) return -1;
		else if (!va && vb) return 1;
		else {
			const d = sa.toLowerCase().localeCompare(sb.toLowerCase());
			if (d) return d < 0 ? -1 : 1;
		}
	}
	return 0;
}

// ---------------------------------------------------------------------------
// network helpers
// ---------------------------------------------------------------------------

function findFreePort() {
	return new Promise((res, rej) => {
		const srv = http.createServer();
		srv.on('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => res(port));
		});
	});
}

function httpOkOnce(url, timeoutMs = 3000) {
	return new Promise((res) => {
		const req = http.get(url, { timeout: timeoutMs }, (r) => {
			r.resume();
			res(r.statusCode >= 200 && r.statusCode < 300);
		});
		req.on('timeout', () => { req.destroy(); res(false); });
		req.on('error', () => res(false));
	});
}

async function waitHttpOk(url, maxSeconds = 90) {
	const deadline = Date.now() + maxSeconds * 1000;
	while (Date.now() < deadline) {
		if (await httpOkOnce(url)) return true;
		await sleep(600);
	}
	return false;
}

/** PIDs listening on a TCP port via netstat (Windows `-ano`, posix fallback). */
function netstatListenPids(port) {
	return new Promise((res) => {
		const args = IS_WINDOWS ? ['-ano', '-p', 'tcp'] : ['-tlnp'];
		execFile(IS_WINDOWS ? 'netstat' : 'ss', args, { timeout: 8000 }, (err, stdout) => {
			if (err && !stdout) return res([]);
			const pids = new Set();
			for (const line of String(stdout).split('\n')) {
				if (IS_WINDOWS) {
					if (/LISTENING/i.test(line) && new RegExp(`[:.]${port}\\s`).test(line)) {
						const m = line.trim().split(/\s+/).pop();
						if (/^\d+$/.test(m)) pids.add(parseInt(m, 10));
					}
				} else if (line.includes(`:${port} `)) {
					const m = /pid=(\d+)/.exec(line);
					if (m) pids.add(parseInt(m[1], 10));
				}
			}
			res([...pids]);
		});
	});
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

const OUT_CAP = 1 << 20;

function collect(child) {
	const out = { stdout: '', stderr: '', truncated: false };
	const push = (key, chunk) => {
		if (out[key].length < OUT_CAP) out[key] += chunk.toString('utf8');
		else out.truncated = true;
	};
	child.stdout?.on('data', (c) => push('stdout', c));
	child.stderr?.on('data', (c) => push('stderr', c));
	return out;
}

function killTree(pid) {
	return new Promise((res) => {
		if (IS_WINDOWS) {
			const c = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			c.on('close', () => res());
			c.on('error', () => res());
		} else {
			try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
			res();
		}
	});
}

async function waitPortFree(port, maxSeconds = 15) {
	const deadline = Date.now() + maxSeconds * 1000;
	while (Date.now() < deadline) {
		const pids = await netstatListenPids(port);
		if (pids.length === 0) return true;
		await sleep(500);
	}
	return (await netstatListenPids(port)).length === 0;
}

/** Run a shell command line (npm.cmd/pnpm.cmd need cmd.exe on Windows).
 * Uses the `cmd /d /s /c "<whole command>"` outer-quote wrap: cmd strips the
 * outer pair and executes the inner verbatim. */
function runShell(cmdline, { cwd, timeoutMs = 600000, env } = {}) {
	return new Promise((res) => {
		const file = IS_WINDOWS ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
		const args = IS_WINDOWS ? ['/d', '/s', '/c', `"${cmdline}"`] : ['-c', cmdline];
		const child = spawn(file, args, { cwd, env: env ? { ...process.env, ...env } : undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const out = collect(child);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
		child.on('close', (code) => {
			clearTimeout(timer);
			res({ code: timedOut ? -1 : (code ?? 1), stdout: out.stdout, stderr: out.stderr, timedOut });
		});
		child.on('error', (e) => {
			clearTimeout(timer);
			res({ code: -1, stdout: out.stdout, stderr: String(e), timedOut });
		});
	});
}

/** Run an executable directly with captured output (no shell). */
function runDirect(file, args, { cwd, timeoutMs = 60000, env } = {}) {
	return new Promise((res) => {
		const child = spawn(file, args, { cwd, env: env ? { ...process.env, ...env } : undefined, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const out = collect(child);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
		child.on('close', (code) => {
			clearTimeout(timer);
			res({ code: timedOut ? -1 : (code ?? 1), stdout: out.stdout, stderr: out.stderr, timedOut });
		});
		child.on('error', (e) => {
			clearTimeout(timer);
			res({ code: -1, stdout: out.stdout, stderr: String(e), timedOut });
		});
	});
}

// ---------------------------------------------------------------------------
// last-good config state
// ---------------------------------------------------------------------------

function entryToRuntimeRoot(entry) {
	if (!entry) return '';
	const marker = `${join('', '')}node_modules`;
	const norm = entry.replace(/\//g, '\\');
	const idx = norm.toLowerCase().lastIndexOf('\\node_modules\\');
	if (idx < 0) return '';
	const root = norm.slice(0, idx);
	return root.startsWith(RUNTIME_DIR) ? root : '';
}

async function readLastGood() {
	const cfg = await readJsonFile(CONFIG_PATH);
	if (cfg && cfg.entry && existsSync(cfg.entry) === false) {
		// keep returning it; existence surfaced separately
	}
	return cfg && cfg.entry ? cfg : null;
}

async function saveLastGood(cfg, event, detail) {
	markManifestOurs(); // any config write implies a plugin-owned change: watchdog grace
	cfg.savedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
	cfg.history = Array.isArray(cfg.history) ? cfg.history : [];
	cfg.history.push({ at: cfg.savedAt, event, detail: detail ?? '' });
	if (cfg.history.length > 20) cfg.history = cfg.history.slice(cfg.history.length - 20);
	const json = JSON.stringify(cfg, null, 2);
	try {
		if (existsSync(CONFIG_PATH)) {
			const old = await readFile(CONFIG_PATH, 'utf8');
			if (old !== json) {
				await ensureDir(BACKUP_DIR);
				await writeFile(join(BACKUP_DIR, `last-good.${stamp()}.json`), old, 'utf8');
				const all = (await readdir(BACKUP_DIR)).filter((f) => f.startsWith('last-good.')).sort().reverse();
				for (const f of all.slice(10)) await rm(join(BACKUP_DIR, f), { force: true }).catch(() => {});
			}
		}
	} catch {}
	await writeText(CONFIG_PATH, json);
}

function profileDirOf(cfg) {
	return join(DSH_HOME, 'profiles', cfg?.profileName || 'web');
}

async function profileDepsSnapshot(profileDir) {
	const pkg = await readJsonFile(join(profileDir, 'package.json'));
	const deps = {};
	if (pkg && pkg.dependencies) for (const [k, v] of Object.entries(pkg.dependencies)) deps[k] = String(v);
	return deps;
}

// ---------------------------------------------------------------------------
// manifest fingerprint / snapshots / watchdog (v0.1.1)
// ---------------------------------------------------------------------------

/** Fingerprint of the boot-relevant profile surface: dependency map,
 * bundle layer list, and a lockfile content hash. */
async function captureManifestState(profileDir) {
	const pkg = await readJsonFile(join(profileDir, 'package.json'));
	const deps = {};
	if (pkg?.dependencies) for (const [k, v] of Object.entries(pkg.dependencies)) deps[k] = String(v);
	const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : [];
	let lockSha1 = '';
	try {
		const lockBuf = await readFile(join(profileDir, 'pnpm-lock.yaml'));
		lockSha1 = crypto.createHash('sha1').update(lockBuf).digest('hex');
	} catch {}
	return { deps, bundles, lockSha1 };
}

/** Human-readable summary of what changed between two manifest states. */
function diffManifestSummary(before, after) {
	const lines = [];
	const keys = new Set([...Object.keys(before?.deps ?? {}), ...Object.keys(after?.deps ?? {})]);
	for (const k of keys) {
		const a = before?.deps?.[k];
		const b = after?.deps?.[k];
		if (a === undefined) lines.push(`新增依赖 ${k}@${b}`);
		else if (b === undefined) lines.push(`移除依赖 ${k}(原 ${a})`);
		else if (a !== b) lines.push(`依赖变更 ${k}: ${a} -> ${b}`);
	}
	const ba = before?.bundles ?? [];
	const bb = after?.bundles ?? [];
	for (const x of bb) if (!ba.includes(x)) lines.push(`bundles 新增 ${x}`);
	for (const x of ba) if (!bb.includes(x)) lines.push(`bundles 移除 ${x}`);
	if ((before?.lockSha1 ?? '') !== (after?.lockSha1 ?? '')) lines.push('锁文件内容变化');
	return lines.length ? lines.join('; ') : '清单内容变化（细节未知）';
}

/** Copy current profile manifests into a tagged snapshot dir; keep last 10.
 * 自动清理说明：快照目录超过 10 份时删除最旧的（它们是历史启动状态的副本，
 * 删除最旧快照不影响当前配置与回滚能力）。 */
async function snapshotProfileFiles(event) {
	const cfgNow = await readLastGood();
	const pDir = profileDirOf(cfgNow);
	const dir = join(SNAPSHOTS_DIR, `${event}-${stamp()}`);
	await ensureDir(dir);
	for (const f of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
		const src = join(pDir, f);
		if (existsSync(src)) await copyFile(src, join(dir, f)).catch(() => {});
	}
	try {
		const dirs = (await readdir(SNAPSHOTS_DIR)).sort().reverse();
		for (const d of dirs.slice(10)) await rm(join(SNAPSHOTS_DIR, d), { recursive: true, force: true }).catch(() => {});
	} catch {}
	logLine(`profile 清单已快照: ${dir}`);
	return dir;
}

/** Refresh cfg.plugins + cfg.profileManifest (incl. snapshot dir) in place.
 * Call right before saveLastGood on every verified-good transition. */
async function withManifestSnapshot(cfg, event) {
	const state = await captureManifestState(profileDirOf(cfg));
	cfg.plugins = { ...state.deps };
	cfg.profileManifest = { ...state, snapshotDir: await snapshotProfileFiles(event) };
}

function safeParse(json) {
	try { return JSON.parse(json); } catch { return null; }
}

async function appendAudit(entry) {
	try {
		await appendFileSafe(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
	} catch {}
}

// watchdog state
let manifestBaselineJson = '';
let manifestOurChangeUntil = 0;
let manifestVerifying = false;

function markManifestOurs() {
	manifestOurChangeUntil = Date.now() + 20000;
}

async function refreshManifestBaseline(profileDir) {
	manifestBaselineJson = JSON.stringify(await captureManifestState(profileDir));
}

/** 5s loop: detect out-of-band profile manifest edits (direct pnpm / manual
 * edits bypassing this plugin), audit + notice + auto canary-verify them.
 * Changes made by our own flows are absorbed silently via the grace window
 * and the busy-job guard. */
async function startWatchdog() {
	await sleep(3000); // let boot settle
	let cfg = await ensureConfig().catch(() => null);
	if (!cfg) return;
	await refreshManifestBaseline(profileDirOf(cfg));
	logLine('清单看门狗已启动（基线已记录）');
	while (true) {
		await sleep(5000);
		try {
			if (manifestVerifying) continue;
			const curCfg = await readLastGood();
			if (!curCfg) continue;
			const pDir = profileDirOf(curCfg);
			const cur = JSON.stringify(await captureManifestState(pDir));
			if (cur === manifestBaselineJson) continue;
			if (busyJob || Date.now() < manifestOurChangeUntil) continue; // our own flow mid-flight
			const summary = diffManifestSummary(JSON.parse(manifestBaselineJson), JSON.parse(cur));
			manifestBaselineJson = cur; // fire once per change set
			manifestVerifying = true;
			try {
				await appendAudit({ kind: 'unauthorized-manifest-change', summary });
				await appendNotice(`检测到 profile 清单被直接修改（未经 safe-launch 端点）: ${summary}。正在自动做兼容性验证...`);
				logLine(`看门狗: 未授权清单变更: ${summary}`);
				const iso = await makeIsoJunctionHome('watchdog', curCfg);
				const t = await canaryTest({ entry: curCfg.entry, isoHome: iso, workdir: curCfg.workdir, label: 'watchdog' });
				if (t.ok) {
					const cfg2 = await readLastGood();
					if (cfg2) await withManifestSnapshot(cfg2, 'watchdog-adopted').then(() => saveLastGood(cfg2, 'watchdog-adopted', summary));
					await appendAudit({ kind: 'watchdog-verified-ok', summary });
					await appendNotice(`手动插件变更经兼容性验证通过，已纳入成功快照: ${summary}。`);
				} else {
					await appendAudit({ kind: 'watchdog-verify-failed', summary, detail: t.detail, logTail: String(t.logTail ?? '').slice(-800) });
					await appendNotice(`警告：未经检查的插件变更且兼容性验证失败！变更: ${summary}。原因: ${t.detail}。当前实例不受影响，但下次启动可能失败。建议调用 rollback-config 回滚清单，或通过 install-plugin 重新规范安装。`);
					logLine(`看门狗: 兼容性验证失败! ${t.detail}`);
				}
			} finally {
				manifestVerifying = false;
			}
		} catch (e) {
			logLine(`看门狗循环异常(继续运行): ${e.message}`);
		}
	}
}

/** The running host IS the reference install: its argv[1] is `<pkg>/lib/bin.js`. */
async function selfEntryInfo() {
	let entry = process.argv[1] ? resolve(process.argv[1]) : '';
	if (!entry || !/bin\.js$/i.test(entry)) return null;
	entry = entry.replace(/\//g, '\\');
	const pkgDir = dirname(dirname(entry));
	try {
		const real = await readFile(join(pkgDir, 'package.json'), 'utf8');
		const manifest = JSON.parse(real);
		if (manifest.name !== DSH_PACKAGE) return null;
		return { entry, version: manifest.version, runtimeRoot: entryToRuntimeRoot(entry), pkgDir };
	} catch {
		return null;
	}
}

async function ensureConfig() {
	let cfg = await readLastGood();
	if (cfg) return cfg;
	const self = await selfEntryInfo();
	if (!self) {
		throw new Error('尚无 last-good 配置，且无法从当前进程推导 dsh 入口；请先运行一次桌面安全启动器。');
	}
	let entry = self.entry;
	if (!self.runtimeRoot) {
		// migrate into owned runtime by copying the verified install
		try {
			entry = (await copyVerifiedRuntime(self.pkgDir.includes('node_modules') ? join(self.pkgDir, '..', '..') : null, self.version)) || entry;
		} catch (e) {
			logLine(`迁移自有运行时失败（继续用现有入口）: ${e.message}`);
		}
	}
	cfg = {
		schema: 1,
		savedAt: '',
		dshPackage: DSH_PACKAGE,
		dshVersion: self.version,
		entry,
		source: 'bootstrap',
		host: '127.0.0.1',
		port: 3080,
		workdir: process.cwd(),
		profileName: 'web',
		extraArgs: [],
		plugins: await profileDepsSnapshot(profileDirOf(null)),
		history: []
	};
	await withManifestSnapshot(cfg, 'bootstrap');
	await saveLastGood(cfg, 'bootstrap-detected-running', `entry=${entry} port=${cfg.port}`);
	logLine(`成功启动配置已保存: ${CONFIG_PATH}`);
	return cfg;
}

// ---------------------------------------------------------------------------
// runtime installation / copying
// ---------------------------------------------------------------------------

function runtimeEntry(version) {
	return join(RUNTIME_DIR, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

async function runtimeReady(version) {
	const marker = join(RUNTIME_DIR, version, '.installed-ok');
	return existsSync(marker) && existsSync(runtimeEntry(version));
}

async function markRuntimeReady(version) {
	await writeText(join(RUNTIME_DIR, version, '.installed-ok'), `ok ${version} ${new Date().toISOString()}`);
}

async function npmViewLatest() {
	const r = await runShell(`npm view ${DSH_PACKAGE} version --fetch-timeout=20000 --fetch-retries=1`, { timeoutMs: 40000 });
	if (r.code !== 0) return '';
	const line = (r.stdout.split('\n').find((l) => l.trim()) || '').trim();
	return /^[\w.\-+]+$/.test(line) ? line : '';
}

async function copyVerifiedRuntime(srcNodeModules, version) {
	if (!srcNodeModules || !existsSync(srcNodeModules)) return null;
	const srcEntry = join(srcNodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	if (!existsSync(srcEntry)) return null;
	if (await runtimeReady(version)) return runtimeEntry(version);
	const dir = join(RUNTIME_DIR, version);
	if (!IS_WINDOWS) return null; // robocopy path is Windows-only; fall back to npm below
	if (existsSync(dir)) {
		logLine(`删除不完整运行时目录后重拷(原因：上次复制未完成): ${dir}`);
		await rm(dir, { recursive: true, force: true });
	}
	await ensureDir(dir);
	const r = await runShell(`robocopy "${srcNodeModules}" "${join(dir, 'node_modules')}" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2`, { timeoutMs: 600000 });
	if (r.code >= 8) throw new Error(`robocopy 复制失败(退出码 ${r.code})`);
	if (!existsSync(runtimeEntry(version))) throw new Error('复制后未找到入口');
	await markRuntimeReady(version);
	logLine(`从已验证安装复制运行时 v${version} 完成`);
	return runtimeEntry(version);
}

async function installRuntime(version, emit = () => {}) {
	if (await runtimeReady(version)) {
		emit(`复用已安装的运行时 v${version}`);
		return runtimeEntry(version);
	}
	const entry = runtimeEntry(version);
	if (existsSync(entry)) {
		emit('检测到完整安装但缺少标记，验证版本后补标记复用');
		const probe = await runDirect('node', [entry, '--version'], { timeoutMs: 30000 });
		if (probe.code === 0 && probe.stdout.trim() === version) {
			await markRuntimeReady(version);
			return entry;
		}
	}
	const dir = join(RUNTIME_DIR, version);
	if (existsSync(dir)) {
		emit(`删除不完整安装目录后重装(原因：上次安装未完成或版本不符): ${dir}`);
		await rm(dir, { recursive: true, force: true });
	}
	await ensureDir(dir);
	emit(`npm 安装 ${DSH_PACKAGE}@${version} 到自有运行时（可能需要几分钟）...`);
	const r = await runShell(`npm install "${DSH_PACKAGE}@${version}" --prefix "${dir}" --no-audit --no-fund`, { timeoutMs: 900000 });
	const logPath = join(LOGS_DIR, `install-${version.replace(/[^\w.\-]/g, '_')}-${stamp()}.log`);
	await writeText(logPath, `# exit=${r.code}\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
	if (r.code !== 0) throw new Error(`npm install 失败(退出码 ${r.code})，日志: ${logPath}`);
	if (!existsSync(entry)) throw new Error(`安装后未找到入口: ${entry}`);
	await markRuntimeReady(version);
	emit(`运行时安装完成: ${dir}`);
	return entry;
}

// ---------------------------------------------------------------------------
// isolated homes + canary
// ---------------------------------------------------------------------------

async function makeIsoHomeBase(tag) {
	const iso = join(tmpdir(), `dsh-canary-${tag}-${stamp()}-${crypto.randomBytes(2).toString('hex')}`);
	await ensureDir(iso);
	for (const f of ['settings.yaml', 'cordis.patch.yml']) {
		const src = join(DSH_HOME, f);
		if (existsSync(src)) await copyFile(src, join(iso, f)).catch(() => {});
	}
	return iso;
}

/** Junction mode: the configured profile linked into the iso home (read-only
 * reuse; for update/watchdog canaries where nothing must be written). */
async function makeIsoJunctionHome(tag, cfg = null) {
	const iso = await makeIsoHomeBase(tag);
	const realProfile = profileDirOf(cfg);
	if (existsSync(realProfile)) {
		await ensureDir(join(iso, 'profiles'));
		await symlink(realProfile, join(iso, 'profiles', cfg?.profileName || 'web'), 'junction');
	}
	return iso;
}

/** Copy mode: standalone profile copy holding ONLY the plugin under test.
 * Manifests are copied but `dependencies` stripped (existing out-of-tree
 * plugins are NOT reinstalled): the compatibility surface under test is
 * [new plugin x dsh core bundle layers]; this avoids dragging every existing
 * plugin's git/build/install quirks into every check and dodges the pnpm
 * virtual-store re-anchor problem entirely. */
async function makeIsoCopyProfileHome(tag, cfg) {
	const iso = await makeIsoHomeBase(tag);
	const srcProfile = profileDirOf(cfg);
	const dstProfile = join(iso, 'profiles', cfg?.profileName || 'web');
	await ensureDir(dstProfile);
	for (const f of ['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']) {
		const src = join(srcProfile, f);
		if (existsSync(src)) await copyFile(src, join(dstProfile, f)).catch(() => {});
	}
	const srcPkg = await readJsonFile(join(srcProfile, 'package.json'));
	if (srcPkg) {
		// keep name/dsh fields (bundle layer list), drop dependency payload
		delete srcPkg.dependencies;
		delete srcPkg.devDependencies;
		await writeText(join(dstProfile, 'package.json'), JSON.stringify(srcPkg, null, 2));
	}
	return { iso, dstProfile };
}

let emitIsoLog = () => {};

const FATAL_PAT = /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|\bFATAL\b|EADDRINUSE|ERR_INTERNAL_ASSERTION/;

/**
 * Canary boot test against a prepared isolated home.
 * Verifies: composed config parses (--dump-config), server reaches HTTP 200,
 * stays alive through an 8s soak, the port owner is exactly our child, and
 * no fatal patterns appear in captured output. Deletes the iso home after.
 */
async function canaryTest({ entry, isoHome, workdir, label }) {
	const result = { ok: false, detail: '', port: 0, logTail: '' };
	const started = Date.now();
	let child = null;
	let port = 0;
	try {
		// static precheck
		const dump = await runDirect('node', [entry, '--profile', 'web', '--dump-config'], { cwd: workdir, timeoutMs: 60000, env: { DSH_HOME: isoHome } });
		if (dump.code !== 0) {
			result.detail = `静态配置组合失败(--dump-config 退出码 ${dump.code}): ${(dump.stderr || dump.stdout).trim().split('\n')[0]}`;
			result.logTail = (dump.stderr + dump.stdout).slice(-2000);
			return result;
		}

		port = await findFreePort();
		result.port = port;
		child = spawn('node', [entry, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
			cwd: workdir,
			env: { ...process.env, DSH_HOME: isoHome },
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const out = collect(child);
		logLine(`金丝雀[${label}] 已启动 pid=${child.pid} port=${port}`);

		const url = `http://127.0.0.1:${port}/`;
		if (!(await waitHttpOk(url, 120))) {
			result.detail = `120 秒内未就绪: ${url}`;
			result.logTail = ((out.stdout || '') + (out.stderr || '')).slice(-2500);
			return result;
		}
		await sleep(8000); // soak
		if (child.exitCode !== null) {
			result.detail = `浸泡期间进程退出(code ${child.exitCode})`;
			result.logTail = ((out.stdout || '') + (out.stderr || '')).slice(-2500);
			return result;
		}
		if (!(await httpOkOnce(url))) {
			result.detail = '浸泡后健康检查失败';
			return result;
		}
		const owners = await netstatListenPids(port);
		if (!owners.includes(child.pid)) {
			result.detail = `端口占用者身份校验失败（期望 pid=${child.pid}，实际 ${owners.join(',') || '无'}）`;
			return result;
		}
		const combined = (out.stdout || '') + '\n' + (out.stderr || '');
		const m = FATAL_PAT.exec(combined);
		if (m) {
			result.detail = `启动日志发现致命错误: ${m[0]}`;
			result.logTail = combined.slice(-2500);
			return result;
		}
		result.ok = true;
		result.detail = '通过：静态配置OK + HTTP就绪 + 浸泡稳定 + 进程身份确认';
		return result;
	} catch (e) {
		result.detail = `异常: ${e.message}`;
		return result;
	} finally {
		if (child && child.exitCode === null) await killTree(child.pid);
		if (port) await waitPortFree(port, 10);
		// 自动清理说明：隔离 HOME 是测试专用临时副本（含 settings 副本与链接/拷贝的
		// profile），残留会占磁盘且含配置副本，因此测试结束即删除。
		await rm(isoHome, { recursive: true, force: true }).catch(() => {});
		result.elapsedMs = Date.now() - started;
		logLine(`金丝雀[${label}] 结果=${result.ok ? 'PASS' : 'FAIL'} 耗时=${Math.round(result.elapsedMs / 1000)}s 详情: ${result.detail}`);
	}
}

// ---------------------------------------------------------------------------
// job registry (single heavy op at a time)
// ---------------------------------------------------------------------------

const jobs = new Map();
let busyJob = null;

function startJob(name, fn) {
	if (busyJob) return { error: { code: 'busy', message: `已有任务在执行: ${busyJob}` } };
	const id = crypto.randomBytes(4).toString('hex');
	const job = { id, name, status: 'running', lines: [], result: null, error: null, startedAt: new Date().toISOString() };
	jobs.set(id, job);
	busyJob = name;
	(async () => {
		try {
			job.result = await fn((msg) => {
				job.lines.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
				if (job.lines.length > 500) job.lines.splice(0, job.lines.length - 500);
				logLine(`[${name}] ${msg}`);
			});
			job.status = 'done';
		} catch (e) {
			job.status = 'error';
			job.error = e.message;
			logLine(`[${name}] 失败: ${e.message}`);
		} finally {
			busyJob = null;
			if (jobs.size > 50) {
				for (const [k, v] of jobs) {
					if (v.status !== 'running' && jobs.size > 25) jobs.delete(k);
				}
			}
		}
	})();
	return { jobId: id };
}

// ---------------------------------------------------------------------------
// update flows
// ---------------------------------------------------------------------------

async function getOutdated(profileDir) {
	const r = await runShell(`pnpm --dir "${profileDir}" outdated --format json`, { timeoutMs: 120000 });
	if ([0, 1].includes(r.code) && r.stdout.trim()) {
		try {
			const j = JSON.parse(r.stdout);
			return Object.entries(j).map(([name, o]) => ({ name, current: String(o.current ?? ''), latest: String(o.latest ?? o.wanted ?? '') }));
		} catch { /* fallthrough */ }
	}
	if (r.code !== 0 && !/Command failed|not recognized|ENOENT/i.test(r.stderr)) return null;
	return [];
}

async function flowCheckUpdates(emit, { apply = false, includePlugins = false } = {}) {
	const cfg = await ensureConfig();
	let latest = '';
	try { latest = await npmViewLatest(); } catch {}
	if (latest) emit(`npm 最新版: ${latest}，当前配置版本: ${cfg.dshVersion}`);
	else emit('无法获取 npm 最新版本（离线？），跳过核心更新检测');

	let coreUpdate = false;
	if (latest && cmpSemver(latest, cfg.dshVersion) > 0) {
		coreUpdate = true;
		emit(`发现核心更新: ${cfg.dshVersion} -> ${latest}`);
		if (!apply) await appendNotice(`DSH 有新版本 ${cfg.dshVersion} -> ${latest}。可用 test-candidate 先测试后升级。`);
	} else if (latest) {
		emit('核心已是最新');
	}

	const pDir = profileDirOf(cfg);
	const outdated = await getOutdated(pDir);
	let pluginNames = [];
	if (outdated === null) emit('插件更新检测失败（pnpm 不可用或出错）');
	else if (outdated.length === 0) emit('插件均已是最新');
	else {
		pluginNames = outdated.map((o) => o.name);
		emit(`发现插件更新: ${outdated.map((o) => `${o.name} ${o.current}->${o.latest}`).join('; ')}`);
		await appendNotice(`DSH 插件有更新: ${pluginNames.join(', ')}。可用 update-plugins 安全更新（先测试后提交）。`);
	}

	if (coreUpdate && apply) {
		const entry = await installRuntime(latest, emit);
		emit(`开始金丝雀测试新版本 ${latest}（独立端口 + 隔离环境，不影响运行中的实例）...`);
		const iso = await makeIsoJunctionHome(latest, cfg);
		const t = await canaryTest({ entry, isoHome: iso, workdir: cfg.workdir, label: latest });
		const isNew = cmpSemver(latest, cfg.dshVersion) > 0;
		if (t.ok) {
			cfg.entry = entry;
			cfg.dshVersion = latest;
			cfg.source = 'candidate-tested';
			await withManifestSnapshot(cfg, 'promoted-candidate');
			await saveLastGood(cfg, 'promoted-candidate', `version=${latest}`);
			await appendNotice(`DSH 新版本 ${latest} 测试通过并已保存为下次启动配置。立即生效请重启。`);
			emit(`新版本 ${latest} 已保存为成功启动配置（旧配置已备份）。重启后生效。`);
		} else {
			if (isNew) {
				const bad = join(RUNTIME_DIR, latest);
				if (existsSync(bad)) {
					emit(`删除测试失败的候选目录(原因：兼容性测试未通过)：${bad}`);
					await rm(bad, { recursive: true, force: true });
				}
			} else {
				emit('自测版本与当前配置相同，保留现有运行时目录。');
			}
			await appendNotice(`DSH 新版本 ${latest} 测试未通过，已保持旧配置。详情见插件日志。`);
			emit(`金丝雀测试未通过: ${t.detail}`);
		}
	}

	if (pluginNames.length > 0 && apply && includePlugins) {
		await flowUpdatePlugins(emit);
	}

	return { coreUpdate, latest: latest || null, pluginsOutdated: pluginNames };
}

async function flowUpdatePlugins(emit) {
	const cfg = await ensureConfig();
	const pDir = profileDirOf(cfg);
	emit('备份 profile 清单...');
	const bakDir = join(SL_DIR, `plugin-backup-${stamp()}`);
	await ensureDir(bakDir);
	for (const f of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
		const src = join(pDir, f);
		if (existsSync(src)) await copyFile(src, join(bakDir, f)).catch(() => {});
	}
	emit(`清单已备份到: ${bakDir}`);

	emit('执行 pnpm update --latest ...');
	let upd = await runShell(`pnpm --dir "${pDir}" update --latest`, { timeoutMs: 600000 });
	if (upd.code !== 0) {
		emit(`pnpm update 失败(退出码 ${upd.code})，回滚清单`);
		for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
		throw new Error(`pnpm update 失败，已回滚清单`);
	}

	emit('对更新后的组合做金丝雀回归测试...');
	const iso = await makeIsoJunctionHome('plugins', cfg);
	const t = await canaryTest({ entry: cfg.entry, isoHome: iso, workdir: cfg.workdir, label: 'plugins' });
	if (t.ok) {
		await withManifestSnapshot(cfg, 'plugins-updated');
		await saveLastGood(cfg, 'plugins-updated', '');
		await appendNotice(`插件更新测试通过并已提交，重启后生效。`);
		emit('插件更新测试通过，已提交。重启后生效。');
		return { ok: true };
	}
	emit(`金丝雀测试失败(${t.detail})，回滚插件清单并按锁文件重装...`);
	for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
	await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
	await appendNotice('插件更新测试未通过，已回滚到更新前状态，实例不受影响。');
	throw new Error(`插件更新后金丝雀测试未通过: ${t.detail}`);
}

// ---------------------------------------------------------------------------
// compatibility-checked plugin installation (the headline feature)
// ---------------------------------------------------------------------------

const SPEC_RE = /^(github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(@[\w.\-]+)?|@?[A-Za-z0-9][A-Za-z0-9._\-/@]*(@[\w.\-]+)?)$/;

async function flowInstallPlugin(emit, source) {
	if (typeof source !== 'string' || source.length > 200 || !SPEC_RE.test(source)) {
		throw new Error('非法的插件来源（支持 npm 包名或 github:owner/repo，且不含特殊字符）');
	}
	const cfg = await ensureConfig();
	const pDir = profileDirOf(cfg);

	emit(`准备隔离测试环境（插件: ${source}）...`);
	const { iso, dstProfile } = await makeIsoCopyProfileHome('plugchk', cfg);

	const depsBefore = await readJsonFile(join(dstProfile, 'package.json'))?.dependencies ?? {};

	emit('在隔离 profile 中安装插件（不影响正在使用的实例）...');
	const addIso = await runShell(`pnpm --dir "${dstProfile}" add "${source}"`, { timeoutMs: 900000 });
	const isoLog = join(LOGS_DIR, `plugchk-${stamp()}.log`);
	await writeText(isoLog, `# exit=${addIso.code}\n${addIso.stdout}\n--- stderr ---\n${addIso.stderr}`);
	if (addIso.code !== 0) {
		const hint = /allowBuilds|prepare/i.test(addIso.stdout + addIso.stderr)
			? '（该插件的构建脚本被 pnpm 拦截：需在其 pnpm-workspace.yaml 的 allowBuilds 中放行后再试）'
			: '';
		throw new Error(`隔离环境安装失败(退出码 ${addIso.code}) ${hint}日志: ${isoLog}`);
	}
	const depsAfter = await readJsonFile(join(dstProfile, 'package.json'))?.dependencies ?? {};
	const addedName = Object.keys(depsAfter).find((k) => !(k in depsBefore)) ?? source;
	emit(`隔离环境安装完成: ${addedName} @ ${depsAfter[addedName] ?? '?'}`);

	emit(`用当前成功配置(v${cfg.dshVersion})在新端口做兼容性启动测试...`);
	const t = await canaryTest({ entry: cfg.entry, isoHome: iso, workdir: cfg.workdir, label: `plugin:${addedName}` });

	if (!t.ok) {
		await appendNotice(`插件 ${source} 兼容性测试未通过，未安装到当前实例。原因: ${t.detail}`);
		throw new Error(`兼容性测试未通过，插件未安装。原因: ${t.detail}${t.logTail ? `\n--- 启动日志尾部 ---\n${t.logTail}` : ''}`);
	}
	emit('兼容性测试通过 ✓  正式安装到当前 profile（官方 dsh plugin add 流程，自动登记 bundles）...');

	// backup real manifests before touching them
	const bakDir = join(SL_DIR, `plugin-backup-${stamp()}`);
	await ensureDir(bakDir);
	for (const f of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
		const src = join(pDir, f);
		if (existsSync(src)) await copyFile(src, join(bakDir, f)).catch(() => {});
	}

	const dshBin = `node "${cfg.entry}"`;
	const addReal = await runShell(`${dshBin} plugin --profile ${cfg.profileName || 'web'} add "${source}"`, { cwd: DSH_HOME, timeoutMs: 900000 });
	const realLog = join(LOGS_DIR, `pluginstall-${stamp()}.log`);
	await writeText(realLog, `# exit=${addReal.code}\n${addReal.stdout}\n--- stderr ---\n${addReal.stderr}`);
	if (addReal.code !== 0) {
		emit('正式安装失败，回滚 profile 清单并按锁文件重装...');
		for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
		await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
		throw new Error(`正式安装失败(退出码 ${addReal.code})，已回滚。日志: ${realLog}`);
	}

	// confirm reconcile registered the bundle
	const realPkg = await readJsonFile(join(pDir, 'package.json'));
	const bundles = realPkg?.dsh?.profile?.bundles ?? [];
	const registered = bundles.includes(addedName);
	if (!registered) {
		emit(`警告: bundles 未包含 ${addedName}（reconcile 异常），回滚...`);
		for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
		await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
		throw new Error('安装后 bundles 登记校验失败，已回滚。');
	}

	await withManifestSnapshot(cfg, 'plugin-installed');
	await saveLastGood(cfg, 'plugin-installed', addedName);
	await appendNotice(`插件 ${addedName}(${source}) 兼容性测试通过并已安装，重启后生效。`);
	emit(`完成: ${addedName} 已装入当前 profile 并登记 bundles ✓ 重启后生效。`);
	return { plugin: addedName, version: depsAfter[addedName] ?? '', requiresRestart: true, bundles };
}

// ---------------------------------------------------------------------------
// restart orchestration (detached helper kills us AFTER replying)
// ---------------------------------------------------------------------------

function scheduleDetachedRestart(cfg) {
	const helper = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'restart-helper.js');
	const child = spawn(process.execPath, [helper, String(cfg.port)], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		cwd: SL_DIR
	});
	child.unref();
	return child.pid;
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const OK = (value) => ({ ok: true, value });
const FAIL = (error) => ({ ok: false, error });
const BAD_REQUEST = { code: 'bad-request', message: '参数错误' };

function json(res, body, status = 200) {
	const data = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(data);
}

function readBody(req) {
	return new Promise((resolvePromise) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > (1 << 20)) { req.destroy(); resolvePromise(null); return; }
			chunks.push(c);
		});
		req.on('end', () => {
			if (chunks.length === 0) return resolvePromise({});
			try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
			catch { resolvePromise(null); }
		});
		req.on('error', () => resolvePromise(null));
	});
}

async function statusPayload(body) {
	const cfg = await readLastGood();
	if (!cfg) return { configured: false, hint: '尚无 last-good 配置：访问任意 /status 会尝试从当前实例引导生成' };
	const url = `http://${cfg.host}:${cfg.port}/`;
	const up = await httpOkOnce(url, 1500);
	const payload = {
		configured: true,
		dshVersion: cfg.dshVersion,
		source: cfg.source,
		savedAt: cfg.savedAt,
		entryExists: existsSync(cfg.entry),
		host: cfg.host,
		port: cfg.port,
		workdir: cfg.workdir,
		running: up,
		listeners: up ? await netstatListenPids(cfg.port) : [],
		plugins: cfg.plugins ?? {},
		manifestDrift: manifestBaselineJson !== '' && JSON.stringify(await captureManifestState(profileDirOf(cfg))) !== manifestBaselineJson,
		selfVersion: PKG_VERSION
	};
	if (body && body.network === true) {
		payload.latest = await npmViewLatest();
		payload.coreUpdateAvailable = payload.latest ? cmpSemver(payload.latest, cfg.dshVersion) > 0 : null;
		const od = await getOutdated(profileDirOf(cfg));
		payload.pluginsOutdated = od ?? null;
	}
	return payload;
}

async function registerRoutes(ctx) {
	const handler = async (req, res) => {
		const pathname = new URL(req.url, 'http://localhost').pathname;
		let payload = {};
		if (req.method === 'POST') {
			payload = await readBody(req);
			if (payload === null) { json(res, FAIL(BAD_REQUEST), 400); return; }
		}
		try {
			switch (pathname) {
				case '/dsh-safe-launch/ping':
					json(res, OK({ plugin: PKG_NAME, version: PKG_VERSION }));
					return;

				case '/dsh-safe-launch/status': {
					json(res, OK(await statusPayload(payload)));
					return;
				}

				case '/dsh-safe-launch/check': {
					const r = startJob('check', (emit) => flowCheckUpdates(emit, { apply: false }));
					if (r.error) { json(res, FAIL(r.error), 409); return; }
					json(res, OK({ jobId: r.jobId }));
					return;
				}

				case '/dsh-safe-launch/test-candidate': {
					const version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : '';
					const r = startJob('test-candidate', async (emit) => {
						const cfg2 = await ensureConfig();
						const ver = version || await npmViewLatest();
						if (!ver) throw new Error('无法获取最新版本号（网络？），请显式传入 version');
						emit(`目标版本: ${ver}（当前 ${cfg2.dshVersion}）`);
						const entry = await installRuntime(ver, emit);
						emit('金丝雀测试中（独立端口 + 隔离 HOME）...');
						const iso = await makeIsoJunctionHome(ver, cfg2);
						const t = await canaryTest({ entry, isoHome: iso, workdir: cfg2.workdir, label: ver });
						if (!t.ok) {
							const isNew = cmpSemver(ver, cfg2.dshVersion) > 0;
							if (isNew) {
								const bad = join(RUNTIME_DIR, ver);
								if (existsSync(bad)) {
									emit(`删除测试失败的候选目录(原因：兼容性测试未通过)：${bad}`);
									await rm(bad, { recursive: true, force: true });
								}
							} else emit('自测版本与当前配置相同，保留现有运行时目录。');
							await appendNotice(`DSH 版本 ${ver} 金丝雀测试未通过，保持旧配置。`);
							throw new Error(`金丝雀测试未通过: ${t.detail}${t.logTail ? `\n${t.logTail}` : ''}`);
						}
						cfg2.entry = entry;
						cfg2.dshVersion = ver;
						cfg2.source = 'candidate-tested';
						await withManifestSnapshot(cfg2, 'promoted-candidate');
						await saveLastGood(cfg2, 'promoted-candidate', `version=${ver}`);
						await appendNotice(`DSH ${ver} 金丝雀测试通过，已保存为下次启动配置。`);
						return { promoted: true, version: ver, requiresRestart: true };
					});
					if (r.error) { json(res, FAIL(r.error), 409); return; }
					json(res, OK({ jobId: r.jobId }));
					return;
				}

				case '/dsh-safe-launch/install-plugin': {
					const source = typeof payload.source === 'string' ? payload.source.trim() : '';
					const r = startJob('install-plugin', (emit) => flowInstallPlugin(emit, source));
					if (r.error) { json(res, FAIL(r.error), 409); return; }
					json(res, OK({ jobId: r.jobId }));
					return;
				}

				case '/dsh-safe-launch/update-plugins': {
					const r = startJob('update-plugins', (emit) => flowUpdatePlugins(emit));
					if (r.error) { json(res, FAIL(r.error), 409); return; }
					json(res, OK({ jobId: r.jobId }));
					return;
				}

				case '/dsh-safe-launch/restart': {
					const cfg = await ensureConfig();
					const helperPid = scheduleDetachedRestart(cfg);
					await appendNotice(`已请求重启（helper pid=${helperPid}），服务将短暂离线后按 last-good 配置恢复。`);
					json(res, OK({ restarting: true, helperPid, note: '服务即将重启，请几秒后刷新页面' }));
					return;
				}

				case '/dsh-safe-launch/rollback-config': {
					const files = (await readdir(BACKUP_DIR).catch(() => []))
						.filter((f) => f.startsWith('last-good.') && f.endsWith('.json'))
						.sort()
						.reverse();
					if (files.length === 0) { json(res, FAIL({ code: 'no-backup', message: '没有可回滚的备份' }), 400); return; }
					const cur = existsSync(CONFIG_PATH) ? await readFile(CONFIG_PATH, 'utf8') : '';
					let picked = null;
					for (const f of files) {
						const content = await readFile(join(BACKUP_DIR, f), 'utf8');
						if (content !== cur) { picked = f; break; }
					}
					if (!picked) { json(res, OK({ rolledBack: false, note: '备份与当前相同' })); return; }
					if (cur) await writeFile(join(BACKUP_DIR, `last-good.${stamp()}.json`), cur, 'utf8');
					await writeFile(CONFIG_PATH, await readFile(join(BACKUP_DIR, picked), 'utf8'));
					const restored = await readLastGood();
					logLine(`配置已回滚到 ${picked}（v${restored?.dshVersion}）`);
					// also restore the recorded profile manifest snapshot when present
					let manifestsRestored = null;
					const snapDir = restored?.profileManifest?.snapshotDir;
					if (snapDir && existsSync(snapDir)) {
						const pDir = profileDirOf(restored);
						markManifestOurs();
						for (const f of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
							const src = join(snapDir, f);
							if (existsSync(src)) await copyFile(src, join(pDir, f)).catch(() => {});
						}
						const inst = await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
						manifestsRestored = { snapshotDir: snapDir, installOk: inst.code === 0 };
						await appendAudit({ kind: 'manifest-rollback', from: snapDir, installOk: inst.code === 0 });
						logLine(`profile 清单已回滚自 ${snapDir}，重装${inst.code === 0 ? '成功' : '失败(退出码 ' + inst.code + ')'}`);
					}
					json(res, OK({
						rolledBack: true,
						from: picked,
						version: restored?.dshVersion,
						manifestsRestored,
						note: '下次 start/restart 生效'
					}));
					return;
				}

				case '/dsh-safe-launch/manifest/status': {
					const cfg = await ensureConfig();
					const current = await captureManifestState(profileDirOf(cfg));
					let baseline = null;
					try { baseline = JSON.parse(manifestBaselineJson); } catch { baseline = cfg.profileManifest ?? null; }
					json(res, OK({
						baseline: baseline,
						current,
						drift: manifestBaselineJson !== '' && JSON.stringify(current) !== manifestBaselineJson,
						verifying: manifestVerifying
					}));
					return;
				}

				case '/dsh-safe-launch/manifest/verify': {
					const r = startJob('manifest-verify', async (emit) => {
						const cfg = await ensureConfig();
						emit('对当前清单组合做金丝雀验证（junction 隔离启动）...');
						const iso = await makeIsoJunctionHome('mverify', cfg);
						const t = await canaryTest({ entry: cfg.entry, isoHome: iso, workdir: cfg.workdir, label: 'manifest-verify' });
						if (!t.ok) {
							await appendAudit({ kind: 'manual-verify-failed', detail: t.detail });
							throw new Error(`兼容性验证未通过: ${t.detail}`);
						}
						markManifestOurs();
						await withManifestSnapshot(cfg, 'manual-verify-adopted');
						await saveLastGood(cfg, 'manifest-verified', '');
						await appendNotice('当前清单组合兼容性验证通过，已纳入成功快照。');
						return { ok: true };
					});
					if (r.error) { json(res, FAIL(r.error), 409); return; }
					json(res, OK({ jobId: r.jobId }));
					return;
				}

				case '/dsh-safe-launch/manifest/ack': {
					const cfg = await ensureConfig();
					const state = await captureManifestState(profileDirOf(cfg));
					await appendAudit({ kind: 'manifest-ack', summary: diffManifestSummary(safeParse(manifestBaselineJson), state) });
					markManifestOurs();
					manifestBaselineJson = JSON.stringify(state);
					await appendNotice('当前清单已被手动确认接受（未做兼容性测试）。');
					json(res, OK({ acknowledged: true }));
					return;
				}

				case '/dsh-safe-launch/job': {
					const id = typeof payload.id === 'string' ? payload.id : '';
					const job = jobs.get(id);
					if (!job) { json(res, FAIL({ code: 'not-found', message: '任务不存在' }), 404); return; }
					json(res, OK({
						id: job.id, name: job.name, status: job.status, lines: job.lines.slice(-80),
						result: job.result, error: job.error
					}));
					return;
				}

				default:
					res.writeHead(404);
					res.end();
			}
		} catch (error) {
			ctx.logger.warn?.(`dsh-safe-launch: ${pathname} failed: ${String(error?.message ?? error)}`);
			json(res, FAIL({ code: 'internal', message: String(error?.message ?? error) }), 500);
		}
	};
	const disposer = ctx.webServer.register({ kind: 'prefix', path: '/dsh-safe-launch', handler });
	logLine(`路由已注册: /dsh-safe-launch/*`);
	return () => disposer();
}

const inject = ['webServer'];

function apply(ctx) {
	ctx.effect(() => registerRoutes(ctx), 'dsh-safe-launch: /dsh-safe-launch routes');
	ensureDir(SL_DIR).then(async () => {
		const cfg = await ensureConfig().catch(() => null);
		if (cfg) logLine(`safe-launch 就绪：当前配置 v${cfg.dshVersion} (${cfg.source})`);
		else logLine('safe-launch 就绪：暂无有效配置（首次调用接口时会自动引导）');
		startWatchdog().catch((e) => logLine(`看门狗启动失败: ${e.message}`));
	}).catch(() => {});
}

export { apply, inject };
