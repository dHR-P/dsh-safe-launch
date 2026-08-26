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
import { readFile, writeFile, mkdir, rm, readdir, copyFile, symlink, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_NAME = 'dsh-safe-launch';
const PKG_VERSION = '0.1.1-rc.2-v0.5.1';
const DSH_PACKAGE = '@deepseek-ai/dsh';
/** 本插件源码仓库（配对更新检测：GitHub releases/latest）。 */
const PKG_REPO = 'dHR-P/dsh-safe-launch';

/** Compatibility posture (v0.2.2, default-open): ANY dsh version may install
 * and run this plugin — the host's existing plugin set is self-consistent and
 * our API surface (webServer.register + logger) is tiny and stable. Dormant
 * mode exists ONLY as an escape hatch for KNOWN-BAD host lines: when a dsh
 * release verifiably breaks us, we ship a plugin update setting `max` to
 * exclude that line. Unknown-old is assumed working; /self-test is the
 * release gate that proves it before each plugin ship. */
const DSH_COMPAT = { min: null, max: null, tested: '0.1.1-rc.2' };

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
const ONBOARDING_PATH = join(SL_DIR, 'onboarding.json');
const LAUNCHER_DIR = join(SL_DIR, 'launcher');
const AGENTS_PATH = join(DSH_HOME, 'AGENTS.md');
const AGENTS_MARKER = '# dsh-safe-launch 接管约定 v1';
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
 * Windows: node spawn auto-wraps an argument containing spaces in outer
 * quotes; cmd /s then strips those outer quotes and passes any inner quotes
 * through verbatim (`-C "\"C:\\path\""`), so pass the whole line verbatim via
 * windowsVerbatimArguments and let cmd parse the inner quotes itself. */
function runShell(cmdline, { cwd, timeoutMs = 600000, env } = {}) {
	return new Promise((res) => {
		const file = IS_WINDOWS ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
		const args = IS_WINDOWS ? ['/d', '/s', '/c', cmdline] : ['-c', cmdline];
		const child = spawn(file, args, { cwd, env: env ? { ...process.env, ...env } : undefined, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

// ---------------------------------------------------------------------------
// adaptive boot command (v0.3): different dsh lines accept different CLI
// shapes ('web' positional vs --profile web, --no-open availability, ...).
// The VERIFIED shape is stored in last-good.json as a TEMPLATE array with
// '{host}'/'{port}' placeholders; everything that boots dsh resolves it.
// ---------------------------------------------------------------------------

const DEFAULT_BOOT_TEMPLATE = ['web', '--host', '{host}', '--port', '{port}', '--no-open'];

function bootTemplateOf(cfg) {
	const t = cfg?.bootArgs;
	return Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === 'string') ? t.map(String) : DEFAULT_BOOT_TEMPLATE;
}

function resolveBootArgs(cfg, portOverride) {
	const host = cfg?.host || '127.0.0.1';
	const port = String(portOverride ?? cfg?.port ?? 3080);
	return bootTemplateOf(cfg).map((s) => s.replaceAll('{host}', host).replaceAll('{port}', port));
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

// ---- UI 心跳关服（v0.4.1，默认关闭；cfg.shutdownOnUiClose=true 才生效）----
const uiHeartbeats = new Map(); // tabId -> lastSeen(ms)
let uiEverSeen = false;
function noteHeartbeat(tabId, event) {
	const id = String(tabId || '').slice(0, 64);
	if (!id) return;
	if (event === 'leave') uiHeartbeats.delete(id);
	else { uiHeartbeats.set(id, Date.now()); uiEverSeen = true; }
}
function startUiCloseWatch(ctx) {
	ctx.effect(() => {
		const timer = setInterval(() => {
			(async () => {
				try {
					let cfg = null;
					try { cfg = await readLastGood(); } catch {}
					if (!cfg || cfg.shutdownOnUiClose !== true) return;
					const now = Date.now();
					for (const [id, ts] of [...uiHeartbeats]) if (now - ts > 60000) uiHeartbeats.delete(id);
					if (!uiEverSeen || uiHeartbeats.size > 0) return;
					// 所有网页都已关闭且开启过开关 → 关闭服务器
					clearInterval(timer);
					logLine('所有浏览器页面已关闭（shutdownOnUiClose），关闭 DSH 实例…');
					await appendNotice('所有页面已关闭（shutdownOnUiClose 已开启），DSH 实例自动关闭。');
					try {
						const pids = await netstatListenPids(cfg.port);
						for (const pid of pids) {
							await new Promise((res) => {
								const k = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
								k.on('close', res); k.on('error', res);
							});
						}
					} catch {}
					setTimeout(() => process.exit(0), 800).unref?.();
				} catch {}
			})();
		}, 5000);
	}, 'dsh-safe-launch: ui-close watcher');
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
	logLine('配置自动巡检已启动（基线已记录）');
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
				logLine(`自动巡检: 检测到配置被直接修改: ${summary}`);
				const iso = await makeIsoJunctionHome('watchdog', curCfg);
				const t = await canaryTest({ entry: curCfg.entry, isoHome: iso, workdir: curCfg.workdir, label: 'watchdog', cfg: curCfg });
				if (t.ok) {
					const cfg2 = await readLastGood();
					if (cfg2) await withManifestSnapshot(cfg2, 'watchdog-adopted').then(() => saveLastGood(cfg2, 'watchdog-adopted', summary));
					await appendAudit({ kind: 'watchdog-verified-ok', summary });
					await appendNotice(`手动插件变更经兼容性验证通过，已纳入成功快照: ${summary}。`);
				} else {
					await appendAudit({ kind: 'watchdog-verify-failed', summary, detail: t.detail, logTail: String(t.logTail ?? '').slice(-800) });
					await appendNotice(`警告：未经检查的插件变更且兼容性验证失败！变更: ${summary}。原因: ${t.detail}。当前实例不受影响，但下次启动可能失败。建议调用 rollback-config 回滚清单，或通过 install-plugin 重新规范安装。`);
					logLine(`自动巡检: 兼容性验证失败! ${t.detail}`);
				}
			} finally {
				manifestVerifying = false;
			}
		} catch (e) {
			logLine(`自动巡检异常(继续运行): ${e.message}`);
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

/** 从本 dsh 进程的真实 argv 捕获启动形状与真实 host/port：
 * 把实际值替换成占位符生成 bootArgs 模板，并回传真实 host/port 供
 * last-good.json 记录（否则重启助手会用错误的端口重启）。
 * 这让任意 dsh 版本的启动命令差异被零配置地记录。 */
function captureBootTemplate(argv) {
	try {
		const list = (argv || []).map(String);
		if (list.length === 0) return null;
		let realHost = null;
		let realPort = null;
		const out = [];
		for (let i = 0; i < list.length; i++) {
			const tok = list[i];
			if (/^--host=/i.test(tok)) {
				realHost = tok.slice('--host='.length);
				out.push('--host={host}');
				continue;
			}
			if (/^--port=/i.test(tok)) {
				realPort = tok.slice('--port='.length);
				out.push('--port={port}');
				continue;
			}
			if (/^--host$/i.test(tok)) {
				realHost = list[i + 1];
				out.push('--host', '{host}');
				i++;
				continue;
			}
			if (/^--port$/i.test(tok)) {
				realPort = list[i + 1];
				out.push('--port', '{port}');
				i++;
				continue;
			}
			if (!realPort && /^\d{2,5}$/.test(tok) && !tok.startsWith('0')) {
				// 无旗标的裸端口（个别旧版形状），保守识别
				realPort = tok;
				out.push('{port}');
				continue;
			}
			out.push(tok);
		}
		if (!realPort) return null;
		return { template: out, host: realHost || '127.0.0.1', port: parseInt(realPort, 10) };
	} catch { return null }
}
/** 覆盖门禁：目标 dsh 版本是否已被本插件声明覆盖（tested >= 目标即视为覆盖）。 */
function isCoveredByPlugin(target) {
	const t = String(target || '').trim().replace(/^v/, '');
	if (!t) return false;
	if (!DSH_COMPAT.tested) return true;
	return cmpSemver(t, DSH_COMPAT.tested) <= 0;
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
	// 零配置捕获本机 dsh 的真实启动形状与真实 host/port（任意版本自动适配）
	const captured = captureBootTemplate(process.argv.slice(2));
	if (captured) {
		cfg.bootArgs = captured.template;
		cfg.host = captured.host;
		cfg.port = captured.port;
		logLine(`启动形状已从运行实例捕获: ${captured.template.join(' ')} (host=${captured.host} port=${captured.port})`);
	}
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

// ---------------------------------------------------------------------------
// 配对更新检测（v0.5.2）：同时查 dsh(npm latest) 与本插件(GitHub releases/latest)。
// 仅当「两者均有新版 且 插件版本前缀 == 目标 dsh 版本」（命名规则天然配对）时
// 才把可执行的合并升级命令暴露给设置卡片；任一/均无则静默返回 null。
// 升级顺序固定为「先升插件、再升 dsh」：新插件版本先行生效后，其适配声明
// (dsh.compat.tested == 前缀) 才会放行 test-candidate 的覆盖门禁。
// 结果缓存 5 分钟（PAIR_TTL_MS）；网络失败一律静默。
// ---------------------------------------------------------------------------

let pairCache = { at: 0, val: null };
const PAIR_TTL_MS = 5 * 60 * 1000;

/** 拆分 `<适配dsh版本>-v<插件自身版本>` 形版本串；形状不符返回 null。 */
function parsePairTag(s) {
	const t = String(s || '').trim().replace(/^v/, '');
	const idx = t.lastIndexOf('-v');
	if (idx < 1) return null;
	const prefix = t.slice(0, idx);
	const own = t.slice(idx + 2);
	if (!/^\d/.test(prefix) || !/^\d/.test(own)) return null;
	return { prefix, own };
}

/** 本插件所在目录的真实路径（junction 已解析），供升级命令指向源码仓库。 */
let pluginRootCached = '';
async function getPluginRoot() {
	if (pluginRootCached) return pluginRootCached;
	try {
		pluginRootCached = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));
	} catch {
		pluginRootCached = join(dirname(fileURLToPath(import.meta.url)), '..');
	}
	return pluginRootCached;
}

/** GitHub 最新 release 的 tag_name；任何失败返回 ''。 */
async function githubLatestRelease() {
	try {
		const headers = { 'User-Agent': `${PKG_NAME}/${PKG_VERSION}`, Accept: 'application/vnd.github+json' };
		const token = String(process.env.GITHUB_TOKEN || '').trim();
		if (token) headers.Authorization = `Bearer ${token}`;
		const r = await fetch(`https://api.github.com/repos/${PKG_REPO}/releases/latest`, {
			headers,
			signal: AbortSignal.timeout(15000)
		});
		if (!r.ok) return '';
		const j = await r.json().catch(() => null);
		return j && typeof j.tag_name === 'string' && j.tag_name ? j.tag_name : '';
	} catch {
		return '';
	}
}

/** 合并升级命令：先切插件新 tag（含重启使其生效），再试运行并采纳新 dsh。 */
async function buildUpgradeCmd(cfg, dshLatest, tag) {
	const port = cfg.port || 3080;
	const base = `http://127.0.0.1:${port}`;
	const repo = await getPluginRoot();
	return [
		'# 配套升级：先升级「安全启动器」插件，再升级 DSH（一次执行）',
		"$ErrorActionPreference = 'Stop'",
		`Set-Location '${repo}'`,
		'git fetch origin --tags',
		`git checkout '${tag}'`,
		"Write-Host '[1/2] 插件已切换到新版本；重启 DSH 加载新插件...'",
		`Invoke-RestMethod -Method Post -Uri '${base}/dsh-safe-launch/restart' -ContentType 'application/json' -Body '{}' | Out-Null`,
		'$deadline = (Get-Date).AddMinutes(4)',
		'$ping = $false',
		'while (-not $ping -and (Get-Date) -lt $deadline) {',
		'  Start-Sleep -Seconds 3',
		`  try { $r = Invoke-WebRequest -UseBasicParsing -Uri '${base}/dsh-safe-launch/ping' -TimeoutSec 5; $ping = ($r.StatusCode -eq 200) } catch { $ping = $false }`,
		'}',
		"if (-not $ping) { throw 'DSH 重启后未就绪（检查新插件是否可加载）；回滚：git checkout 旧版本后重启' }",
		"Write-Host '[2/2] 后台试运行并采纳新 dsh（不影响当前实例）...'",
		`$job = Invoke-RestMethod -Method Post -Uri '${base}/dsh-safe-launch/test-candidate' -ContentType 'application/json' -Body '{"version":"${dshLatest}"}'`,
		'$jobId = $job.value.jobId',
		'$done = $false',
		'do {',
		'  Start-Sleep -Seconds 4',
		"  $s = Invoke-RestMethod -Method Post -Uri '${base}/dsh-safe-launch/job' -ContentType 'application/json' -Body ('{\"id\":\"' + $jobId + '\"}')",
		'  $st = $s.value.status',
		"  if ($st -eq 'done') { $done = $true; Write-Host ('升级完成：' + $s.value.result) }",
		"  elseif ($st -eq 'error') { $done = $true; throw ('试运行失败：' + $s.value.error) }",
		'} while (-not $done)',
		"Write-Host '完成！DSH 新版本已保存为下次启动配置，重启后生效。'"
	].join('\n');
}

/** 计算配对更新对象；未配对/离线/异常一律返回 null（静默）。 */
async function computePairUpdate(dshLatestHint) {
	try {
		const cfg = await readLastGood();
		if (!cfg) return null;
		const dshLatest = dshLatestHint || await npmViewLatest();
		if (!dshLatest) return null;
		const tag = await githubLatestRelease();
		if (!tag) return null;
		const news = parsePairTag(tag);
		const curOwn = (parsePairTag(PKG_VERSION) || {}).own || PKG_VERSION;
		if (!news) return null;
		const dshNewer = cmpSemver(dshLatest, cfg.dshVersion) > 0;
		const pluginNewer = cmpSemver(news.own, curOwn) > 0;
		const paired = dshNewer && pluginNewer && news.prefix === String(dshLatest).trim().replace(/^v/, '');
		if (!paired) return null;
		return {
			available: true,
			checkedAt: new Date().toISOString(),
			dshLatest,
			pluginTag: tag,
			pluginPrefix: news.prefix,
			pluginVersion: news.own,
			upgradeCmd: await buildUpgradeCmd(cfg, dshLatest, tag)
		};
	} catch {
		return null;
	}
}

async function ensurePairUpdate(force, dshLatestHint) {
	const now = Date.now();
	if (!force && pairCache.val && now - pairCache.at < PAIR_TTL_MS) return pairCache.val;
	const v = await computePairUpdate(dshLatestHint);
	pairCache = { at: now, val: v };
	return v;
}

/** 启动后预热配对检测（网页就绪后随更新检查一起执行；DSH_SL_NO_AUTO_CHECK=1 禁用）。 */
async function prewarmPairUpdate() {
	if (String(process.env.DSH_SL_NO_AUTO_CHECK || '').trim() === '1') return;
	try {
		const v = await ensurePairUpdate(true);
		if (v && v.available) {
			logLine(`配对更新检测: dsh ${v.dshLatest} 与插件 ${v.pluginTag} 配对，可配套升级（升级命令已就绪）`);
			await appendNotice(`配套升级可用：请先升级 dsh-safe-launch 至 ${v.pluginTag}（适配 dsh ${v.dshLatest}），再升级 DSH。详见设置卡片中的升级命令。`);
		} else {
			logLine('配对更新检测: 无配套新版本（或离线/网络失败，静默）');
		}
	} catch (e) {
		logLine(`配对更新检测失败(忽略): ${e.message}`);
	}
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

/** 候选测试专用隔离家：manifests 为「基线+候选」组合的独立副本，
 * node_modules 以 junction 共享真实安装（零拷贝）。 */

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
async function canaryTest({ entry, isoHome, workdir, label, cfg }) {
	const result = { ok: false, detail: '', port: 0, logTail: '' };
	const started = Date.now();
	let child = null;
	let port = 0;
	try {
		// static precheck — ADVISORY ONLY since v0.2.2: older dsh lines may not
		// support --dump-config/--profile flags; a failure here is logged and
		// the real boot test below remains the source of truth.
		const dump = await runDirect('node', [entry, '--profile', 'web', '--dump-config'], { cwd: workdir, timeoutMs: 60000, env: { DSH_HOME: isoHome } });
		if (dump.code !== 0) {
			result.dumpWarning = `静态预检未通过(可能为旧版 dsh 不支持该参数，已跳过继续真实启动测试): ${(dump.stderr || dump.stdout).trim().split('\n')[0]}`;
			logLine(`[试运行 ${label}] ${result.dumpWarning}`);
		}

		port = await findFreePort();
		result.port = port;
		const bootArgs = resolveBootArgs(cfg, port);
		child = spawn('node', [entry, ...bootArgs], {
			cwd: workdir,
			env: { ...process.env, DSH_HOME: isoHome },
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const out = collect(child);
		logLine(`[试运行 ${label}] 已启动 pid=${child.pid} port=${port}`);

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
		// 自动清理说明：临时环境是测试专用副本（含 settings 副本与链接/拷贝的
		// profile），残留会占磁盘且含配置副本，因此测试结束即删除。
		await rm(isoHome, { recursive: true, force: true }).catch(() => {});
		result.elapsedMs = Date.now() - started;
		logLine(`[试运行 ${label}] 结果=${result.ok ? 'PASS' : 'FAIL'} 耗时=${Math.round(result.elapsedMs / 1000)}s 详情: ${result.detail}`);
	}
}

// ---------------------------------------------------------------------------
// startup update notice (v0.1.2): boot NEVER touches new versions; ~30s after
// boot we check npm once, and if a newer core exists we only NOTIFY. The
// download + isolated canary test happens exclusively after explicit consent
// (POST /test-candidate), which itself never touches the running instance.
// Set env DSH_SL_NO_AUTO_CHECK=1 to disable the check entirely.
// ---------------------------------------------------------------------------

let pendingCoreUpdate = null;

async function startupUpdateNotice() {
	try {
		if (String(process.env.DSH_SL_NO_AUTO_CHECK || '').trim() === '1') return;
		const cfg = await readLastGood();
		if (!cfg) return;
		const latest = await npmViewLatest();
		if (!latest) { logLine('启动后更新检查: 无法获取 npm 最新版（离线？），跳过'); return; }
		if (cmpSemver(latest, cfg.dshVersion) <= 0) {
			logLine(`启动后更新检查: 核心已是最新 (${cfg.dshVersion})`);
			return;
		}
		pendingCoreUpdate = { version: latest, currentVersion: cfg.dshVersion, detectedAt: new Date().toISOString() };
		await appendNotice(`DSH 有新版本 ${cfg.dshVersion} -> ${latest}。本次启动仍使用已验证的旧版本，未做任何改动。确认升级请调用 POST /dsh-safe-launch/test-candidate {}：后台下载 + 随机端口试运行验证（新版核心 × 当前全部插件组合），通过后才写入配置，届时可再决定是否立即重启。`);
		logLine(`发现核心新版本 ${latest}（仅提示，未下载；等待同意后测试）`);
	} catch (e) {
		logLine(`启动更新检查失败(忽略): ${e.message}`);
	}
}

// ---------------------------------------------------------------------------
// onboarding (v0.2.0): first run behaves like any normal plugin. After the
// user consents, this plugin takes over DSH booting (thin desktop launcher)
// and plugin installation (AGENTS.md convention). Nothing machine-specific
// is required beforehand; everything is generated into $DSH_HOME/safe-launch.
// ---------------------------------------------------------------------------

/** 轮询本实例 HTTP 直到就绪（用于「网页成功运行后立即检查更新」）。 */
async function waitForSelfHttp(budgetMs) {
	let port = 0;
	try { const c = await readLastGood(); if (c && c.port) port = Number(c.port); } catch {}
	if (!port) port = 3080;
	const url = 'http://127.0.0.1:' + port + '/';
	const t0 = Date.now();
	while (Date.now() - t0 < budgetMs) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
			if (r.status < 600) return true;
		} catch {}
		await sleep(600);
	}
	return false;
}
async function readOnboarding() {
	const j = await readJsonFile(ONBOARDING_PATH);
	if (j && (j.status === 'accepted' || j.status === 'declined')) return j;
	return { status: 'pending', askedAt: null };
}

async function writeOnboarding(state) {
	await writeText(ONBOARDING_PATH, JSON.stringify(state, null, 2));
	return state;
}

/** The generated thin launcher: boot from last-good only, self-heal manifests
 * once on failure, open browser. No update logic here — that lives in-process. */
const LAUNCHER_PS = `\uFEFF# ============================================================
# DSH 安全启动（由 dsh-safe-launch 插件生成；可随时删除重建）
# 行为：弹窗显示「正在诊断兼容性」→ 按当前配置在固定端口启动；
#       成功即用；失败自动回退到上一次成功版本再启动；
#       结果写入 safe-launch/last-diagnosis.json 供设置页展示。
# ============================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$sl      = Join-Path $env:USERPROFILE '.dsh\\safe-launch'
$cfgPath = Join-Path $sl 'last-good.json'
if (-not (Test-Path -LiteralPath $cfgPath)) {
    [System.Windows.Forms.MessageBox]::Show('尚未生成成功启动配置。请先正常启动一次 DSH 并安装 dsh-safe-launch 插件。', 'DSH 安全启动') | Out-Null
    exit 1
}
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$url = 'http://{0}:{1}/' -f $cfg.host, $cfg.port

$form      = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 安全启动'
$form.Size = New-Object System.Drawing.Size(430, 150)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$lbl = New-Object System.Windows.Forms.Label
$lbl.Dock = 'Fill'
$lbl.TextAlign = 'MiddleCenter'
$lbl.Font = New-Object System.Drawing.Font('Microsoft YaHei', 10)
$lbl.Text = '正在诊断兼容性…'
$form.Controls.Add($lbl)
$form.Show()
[System.Windows.Forms.Application]::DoEvents()
function Set-Lbl { param($t) $lbl.Text = $t; [System.Windows.Forms.Application]::DoEvents() }
function Test-Up {
    try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; return ($r.StatusCode -eq 200) } catch { return $false }
}
if (Test-Up) { Set-Lbl 'DSH 已在运行，直接打开页面。'; Start-Process $url; Start-Sleep -Milliseconds 1200; $form.Close(); exit 0 }

$bootArgs = @((@($cfg.bootArgs) | ForEach-Object { $_.Replace('{host}', $cfg.host).Replace('{port}', "$($cfg.port)") }))
if (@($bootArgs).Count -eq 0) { $bootArgs = @('web', '--host', $cfg.host, '--port', "$($cfg.port)", '--no-open') }
$extra = @(); if ($cfg.extraArgs) { $extra = @($cfg.extraArgs) }

# 差异集：当前配置里、上一次成功清单中没有的插件（回退时记为「不兼容嫌疑」）
$suspects = @()
try {
    $pkgPath = Join-Path $env:USERPROFILE '.dsh\\profiles\\web\\package.json'
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $curB = @($pkg.dsh.profile.bundles)
    $verB = @(); if ($cfg.profileManifest) { $verB = @($cfg.profileManifest.bundles) }
    $suspects = @($curB | Where-Object { $verB -notcontains $_ })
} catch {}

function Kill-Port { foreach ($line in (netstat -ano -p tcp | Select-String 'LISTENING')) { if ($line.Line -match ":$($cfg.port)\s") { $pid2 = $line.Line.Trim().Split(' ')[-1]; if ($pid2 -match '^\d+$') { taskkill /PID $pid2 /T /F 2>$null | Out-Null } } } }
function Write-Diag { param($ok, $fallback)
    try {
        @{ at = (Get-Date).ToString('o'); ok = $ok; usedFallback = $fallback; incompatible = $suspects; dshEntry = $cfg.entry } |
            ConvertTo-Json -Depth 3 | Out-File -LiteralPath (Join-Path $sl 'last-diagnosis.json') -Encoding utf8
    } catch {}
}

Set-Lbl '正在诊断兼容性…（按当前配置启动）'
$p = Start-Process node.exe -ArgumentList (@(''"'' + $cfg.entry + ''"'') + @($bootArgs) + $extra) -WorkingDirectory $cfg.workdir -WindowStyle Hidden -PassThru
$ok = $false
foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 1000
    Set-Lbl ("正在诊断兼容性… {0}s" -f $i)
    if (Test-Up) { $ok = $true; break }
}
if ($ok) {
    Write-Diag $true $false
    Set-Lbl '兼容性诊断通过，已按当前配置启动。'
    Start-Process $url
    Start-Sleep -Milliseconds 1500
    $form.Close(); exit 0
}

# ---- 诊断失败：回退到上一次成功版本 ----
Kill-Port
Set-Lbl '诊断失败，正在回退到上一次成功版本…'
$snaps = @(Get-ChildItem -LiteralPath (Join-Path $sl 'profile-snapshots') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
if ($snaps.Count -gt 0) {
    foreach ($f in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
        $src = Join-Path $snaps[0].FullName $f
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $env:USERPROFILE '.dsh\\profiles\\web') -Force }
    }
    $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if ($pnpm) {
        & cmd.exe /d /s /c ('& "' + $pnpm.Source + '" --dir "' + (Join-Path $env:USERPROFILE '.dsh\\profiles\\web') + '" install --frozen-lockfile') | Out-Null
    }
} else {
    # 无快照可回退：若记录了不同版本的入口则切换入口重试（如 runtime 旧版本）
    if ($cfg.runtimeEntry -and (Test-Path -LiteralPath $cfg.runtimeEntry)) { $cfg.entry = $cfg.runtimeEntry }
}
Start-Sleep -Seconds 2
try { $pre2 = Invoke-WebRequest ("http://" + $cfg.host + ":" + $cfg.port + "/") -UseBasicParsing -TimeoutSec 3; if ($pre2.StatusCode -eq 200) { Write-Host 'DSH 已在运行，直接打开。'; Start-Process ("http://" + $cfg.host + ":" + $cfg.port + "/"); exit 0 } } catch {}
$p2 = Start-Process node.exe -ArgumentList (@(''"'' + $cfg.entry + ''"'') + @($bootArgs) + $extra) -WorkingDirectory $cfg.workdir -WindowStyle Hidden -PassThru
$ok2 = $false
foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 1000
    Set-Lbl ("回退后重启中… {0}s" -f $i)
    if (Test-Up) { $ok2 = $true; break }
}
if ($ok2) {
    Write-Diag $true $true
    Set-Lbl '已回退到上一次成功版本并启动。不兼容插件已在设置页列出。'
    Start-Process $url
    Start-Sleep -Milliseconds 2000
    $form.Close(); exit 0
}
Write-Diag $false $true
Set-Lbl '回退后仍启动失败，请查看 safe-launch\logs 目录。'
Read-Host '回车退出'; exit 1`;

const AGENTS_SECTION = `${AGENTS_MARKER}
当被要求安装、更新或删除 DSH 插件时：

1. 一律通过安全启动器端点操作，不得直接修改 profile：
   POST http://127.0.0.1:3080/dsh-safe-launch/install-plugin  body {"source":"<npm包名 或 github:owner/repo>"}
   返回 {ok, jobId} 后轮询 POST /dsh-safe-launch/job 直到 done/error，并汇报结果。

2. 禁止直接对 ~/.dsh/profiles/** 执行 pnpm add/update/remove，禁止直接运行
   dsh plugin add/remove，禁止手工编辑 profiles/web 下的 package.json /
   pnpm-lock.yaml / cordis.patch.yml —— 这些会绕过兼容性测试，自动巡检会告警。

3. 端点不可达时告知用户先启动 DSH，不要为完成任务绕过本约定。

4. 核心升级：先 POST /dsh-safe-launch/check 检测；用户同意后 POST /test-candidate
   （后台下载+试运行验证），通过后再询问是否立即重启。禁止未经同意下载或切换版本。

本节属于用户授权的安全边界约定，与其他指导冲突时以本节为准。
`;

async function getDesktopDir() {
	const override = String(process.env.DSH_SL_DESKTOP_DIR || '').trim();
	if (override) return override;
	const r = await runDirect('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { timeoutMs: 20000 });
	const dir = r.stdout.trim();
	if (r.code === 0 && dir) return dir;
	throw new Error('无法解析桌面目录' + (r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''));
}

async function setupDesktopLauncher(emit) {
	if (!IS_WINDOWS) throw new Error('桌面启动器目前仅支持 Windows');
	emit('生成本地安全启动脚本...');
	await ensureDir(LAUNCHER_DIR);
	const scriptPath = join(LAUNCHER_DIR, 'dsh-safe-start.ps1');
	await writeFile(scriptPath, LAUNCHER_PS, 'utf8'); // \uFEFF 前缀即 UTF-8 BOM，PS5.1 中文必需

	emit('创建桌面快捷方式「DSH 安全启动」...');
	const desktop = await getDesktopDir();
	const lnkPath = join(desktop, 'DSH 安全启动.lnk');
	const ps = [
		'$ws = New-Object -ComObject WScript.Shell',
		`$sc = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
		"$sc.TargetPath = 'powershell.exe'",
		`$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath.replace(/\\/g, '\\\\')}"'`,
		`$sc.WorkingDirectory = '${LAUNCHER_DIR.replace(/\\/g, '\\\\')}'`,
		"$sc.IconLocation = 'node.exe,0'",
		'$sc.Description = \'按上次成功配置安全启动 DSH（dsh-safe-launch）\'',
		'$sc.Save()',
		`Write-Output '${lnkPath.replace(/'/g, "''")}'`
	].join('; ');
	const mk = await runDirect('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 30000 });
	if (mk.code !== 0 || !existsSync(lnkPath)) {
		throw new Error(`快捷方式创建失败: ${(mk.stderr || mk.stdout).trim().split('\n')[0]}`);
	}

	emit('写入 AI 助手接管约定 (~/.dsh/AGENTS.md)...');
	let agentsCurrent = '';
	try { agentsCurrent = await readFile(AGENTS_PATH, 'utf8'); } catch {}
	if (!agentsCurrent.includes('dsh-safe-launch/install-plugin')) {
		const head = agentsCurrent.trim().length > 0 ? agentsCurrent.trimEnd() + '\n\n' : '# DSH 全局工作约定\n\n';
		await writeText(AGENTS_PATH, head + AGENTS_SECTION);
	} else {
		emit('接管约定已存在，跳过');
	}

	const st = await writeOnboarding({ status: 'accepted', acceptedAt: new Date().toISOString(), launcher: scriptPath, shortcut: lnkPath });
	const cfg = await ensureConfig();
	await saveLastGood(cfg, 'takeover-accepted', `launcher=${scriptPath}`);
	await appendNotice('已授权接管：桌面快捷方式已创建，AI 安装约定已写入。之后可完全通过本插件管理启动与插件。');
	logLine(`接管完成: ${st.shortcut}`);
	return { script: scriptPath, shortcut: lnkPath, agentsUpdated: true };
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
		emit(`开始试运行新版本 ${latest}（独立端口 + 隔离环境，不影响运行中的实例）...`);
		const iso = await makeIsoJunctionHome(latest, cfg);
		const t = await canaryTest({ entry, isoHome: iso, workdir: cfg.workdir, label: latest, cfg });
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
			emit(`试运行未通过: ${t.detail}`);
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

	emit('对更新后的组合做试运行回归测试...');
	const iso = await makeIsoJunctionHome('plugins', cfg);
	const t = await canaryTest({ entry: cfg.entry, isoHome: iso, workdir: cfg.workdir, label: 'plugins', cfg });
	if (t.ok) {
		await withManifestSnapshot(cfg, 'plugins-updated');
		await saveLastGood(cfg, 'plugins-updated', '');
		await appendNotice(`插件更新测试通过并已提交，重启后生效。`);
		emit('插件更新测试通过，已提交。重启后生效。');
		return { ok: true };
	}
	emit(`试运行失败(${t.detail})，回滚插件清单并按锁文件重装...`);
	for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
	await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
	await appendNotice('插件更新测试未通过，已回滚到更新前状态，实例不受影响。');
	throw new Error(`插件更新后试运行未通过: ${t.detail}`);
}

// ---------------------------------------------------------------------------
// host compatibility self-test (v0.2.1): prove the CURRENT plugin+profile set
// boots against arbitrary dsh versions (older lines & new releases) before we
// declare/keep support. This is the release gate behind "随 dsh 更新而更新".
// ---------------------------------------------------------------------------

async function flowSelfTest(emit, versions) {
	const cfg = await ensureConfig();
	const targets = [];
	for (const v of Array.isArray(versions) ? versions : []) {
		const t = String(v ?? '').trim();
		if (/^[\w.\-+]+$/.test(t) && t.length <= 40 && !targets.includes(t)) targets.push(t);
	}
	if (targets.length === 0) {
		const latest = await npmViewLatest();
		if (!latest) throw new Error('无法获取 npm 最新版本（网络？），请显式传入 versions 数组');
		targets.push(latest);
	}
	if (targets.length > 5) targets.length = 5;
	emit(`待测 dsh 版本: ${targets.join(', ')}（当前配置 ${cfg.dshVersion}；测试组合=新版核心 × 当前全部插件）`);
	const rows = [];
	for (const v of targets) {
		try {
			const entry = await installRuntime(v, emit);
			const iso = await makeIsoJunctionHome('selftest', cfg);
			const t = await canaryTest({ entry, isoHome: iso, workdir: cfg.workdir, label: `selftest:${v}`, cfg });
			rows.push({ version: v, ok: t.ok, detail: t.detail });
		} catch (e) {
			rows.push({ version: v, ok: false, detail: e.message });
		}
	}
	const passCount = rows.filter((r) => r.ok).length;
	emit(`自测完成: ${passCount}/${rows.length} 通过`);
	await appendNotice(`dsh 兼容性自测: ${rows.map((r) => `${r.version}=${r.ok ? 'PASS' : 'FAIL'}`).join('; ')}`);
	return { current: cfg.dshVersion, supported: { min: DSH_COMPAT.min, max: DSH_COMPAT.max }, rows, passCount, total: rows.length };
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
	const t = await canaryTest({ entry: cfg.entry, isoHome: iso, workdir: cfg.workdir, label: `plugin:${addedName}`, cfg });

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

	// v0.2.2 fallback for older dsh lines without a working `plugin add`:
	// replicate the reconcile ourselves (pnpm add + bundles append).
	if (addReal.code !== 0) {
		emit(`官方 plugin add 失败(退出码 ${addReal.code})，尝试版本无关的手动安装路径...`);
		const manual = await runShell(`pnpm --dir "${pDir}" add "${source}"`, { timeoutMs: 900000 });
		const manualLog = join(LOGS_DIR, `pluginstall-manual-${stamp()}.log`);
		await writeText(manualLog, `# exit=${manual.code}\n${manual.stdout}\n--- stderr ---\n${manual.stderr}`);
		let manuallyRegistered = false;
		if (manual.code === 0) {
			try {
				const mpkg = await readJsonFile(join(pDir, 'package.json'));
				if (mpkg && !mpkg.dependencies[addedName]) throw new Error(`依赖未出现: ${addedName}`);
				mpkg.dsh = mpkg.dsh || {};
				mpkg.dsh.profile = mpkg.dsh.profile || {};
				const list = Array.isArray(mpkg.dsh.profile.bundles) ? mpkg.dsh.profile.bundles.map(String) : [];
				if (!list.includes(addedName)) list.push(addedName);
				mpkg.dsh.profile.bundles = list;
				await writeText(join(pDir, 'package.json'), JSON.stringify(mpkg, null, 2));
				manuallyRegistered = true;
			} catch (e) {
				emit(`手动登记失败: ${e.message}`);
			}
		}
		if (!manuallyRegistered) {
			emit('手动安装路径也失败，回滚 profile 清单并按锁文件重装...');
			for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
			await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
			throw new Error(`正式安装与手动回退均失败(官方退出码 ${addReal.code})，已回滚。日志: ${realLog} / ${manualLog}`);
		}
		emit('手动安装路径成功（依赖 + bundles 已登记）');
	}

	// confirm the bundle is registered (either by official reconcile or fallback)
	const realPkg = await readJsonFile(join(pDir, 'package.json'));
	const bundles = realPkg?.dsh?.profile?.bundles ?? [];
	const registered = bundles.includes(addedName);
	if (!registered) {
		emit(`警告: bundles 未包含 ${addedName}（reconcile 异常），补登记后复验...`);
		realPkg.dsh = realPkg.dsh || {};
		realPkg.dsh.profile = realPkg.dsh.profile || {};
		const list = Array.isArray(realPkg.dsh.profile.bundles) ? realPkg.dsh.profile.bundles.map(String) : [];
		list.push(addedName);
		realPkg.dsh.profile.bundles = list;
		await writeText(join(pDir, 'package.json'), JSON.stringify(realPkg, null, 2));
		const recheck = await readJsonFile(join(pDir, 'package.json'));
		if (!(recheck?.dsh?.profile?.bundles ?? []).includes(addedName)) {
			for (const f of await readdir(bakDir)) await copyFile(join(bakDir, f), join(pDir, f)).catch(() => {});
			await runShell(`pnpm --dir "${pDir}" install --frozen-lockfile`, { timeoutMs: 600000 });
			throw new Error('安装后 bundles 登记校验失败（含补登记），已回滚。');
		}
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
	const ob0 = await readOnboarding();
	if (!cfg) return { configured: false, hint: '尚无 last-good 配置：访问任意 /status 会尝试从当前实例引导生成' };
	const url = `http://${cfg.host}:${cfg.port}/`;
	const up = await httpOkOnce(url, 1500);
	let lastDiagnosis = null;
	try { lastDiagnosis = JSON.parse(await readFile(join(SL_DIR, 'last-diagnosis.json'), 'utf8')); } catch {}
	const incompatiblePlugins = lastDiagnosis && Array.isArray(lastDiagnosis.incompatible) ? lastDiagnosis.incompatible : [];
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
		history: (cfg.history ?? []).slice(0, 3),
		launcher: (ob0 && ob0.launcher) || null,
		shutdownOnUiClose: cfg.shutdownOnUiClose === true,
		manifestDrift: manifestBaselineJson !== '' && JSON.stringify(await captureManifestState(profileDirOf(cfg))) !== manifestBaselineJson,
		coreUpdatePending: pendingCoreUpdate,
		onboarding: await readOnboarding(),
		selfVersion: PKG_VERSION,
		testedDshVersion: DSH_COMPAT.tested,
		lastDiagnosis,
		incompatiblePlugins
	};
	if (body && body.network === true) {
		const latest = await npmViewLatest();
		payload.latest = latest;
		payload.coreUpdateAvailable = latest ? cmpSemver(latest, cfg.dshVersion) > 0 : null;
		const od = await getOutdated(profileDirOf(cfg));
		payload.pluginsOutdated = od ?? null;
		payload.combinedUpdate = await ensurePairUpdate(false, latest);
	} else {
		payload.combinedUpdate = await ensurePairUpdate(false);
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
					if (req.method === 'GET') { json(res, OK({ hello: true, v: PKG_VERSION })); return; }
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
					// 覆盖门禁：只有当本插件版本已声明支持目标 dsh 版本（tested >= 目标）时才允许测试
					const gateVer0 = version || (pendingCoreUpdate && pendingCoreUpdate.latest) || '';
					const gateVer = String(gateVer0).trim().replace(/^v/, '');
					if (gateVer && !isCoveredByPlugin(gateVer) && payload.force !== true) {
						json(res, FAIL({
							code: 'not-covered',
							message: `本插件 v${PKG_VERSION} 目前声明覆盖到 dsh ${DSH_COMPAT.tested}；目标 dsh ${gateVer} 尚未被覆盖。请先发布/安装覆盖该版本的插件更新，再用 force:true 强制测试。`
						}), 409);
						return;
					}
					const r = startJob('test-candidate', async (emit) => {
						const cfg2 = await ensureConfig();
						const ver = version || await npmViewLatest();
						if (!ver) throw new Error('无法获取最新版本号（网络？），请显式传入 version');
						emit(`目标版本: ${ver}（当前 ${cfg2.dshVersion}）`);
						const entry = await installRuntime(ver, emit);
						emit('试运行新配置中（独立端口 + 临时环境）...');
						const iso = await makeIsoJunctionHome(ver, cfg2);
						const t = await canaryTest({ entry, isoHome: iso, workdir: cfg2.workdir, label: ver, cfg: cfg2 });
						if (!t.ok) {
							const isNew = cmpSemver(ver, cfg2.dshVersion) > 0;
							if (isNew) {
								const bad = join(RUNTIME_DIR, ver);
								if (existsSync(bad)) {
									emit(`删除测试失败的候选目录(原因：兼容性测试未通过)：${bad}`);
									await rm(bad, { recursive: true, force: true });
								}
							} else emit('自测版本与当前配置相同，保留现有运行时目录。');
							await appendNotice(`DSH 版本 ${ver} 试运行未通过，保持旧配置。`);
							throw new Error(`试运行未通过: ${t.detail}${t.logTail ? `\n${t.logTail}` : ''}`);
						}
						cfg2.entry = entry;
						cfg2.dshVersion = ver;
						cfg2.source = 'candidate-tested';
						await withManifestSnapshot(cfg2, 'promoted-candidate');
						await saveLastGood(cfg2, 'promoted-candidate', `version=${ver}`);
						await appendNotice(`DSH ${ver} 试运行测试通过，已保存为下次启动配置。`);
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

				case '/dsh-safe-launch/pair/checkout': {
					// 一键配对升级第 1 步：把插件目录切换到适配新 dsh 的 release tag。
					// 只做 git 操作（取回+校验+切换），不重启；任何失败都保持工作区原状。
					const tag = typeof payload.tag === 'string' && /^[\w.\-+]+$/.test(payload.tag) ? payload.tag.trim() : '';
					if (!tag) { json(res, FAIL(BAD_REQUEST), 400); return; }
					const repo = await getPluginRoot();
					const git = (args, timeoutMs) => runShell(`git -C "${repo}" ${args}`, { timeoutMs });
					const wc = await git('rev-parse --is-inside-work-tree', 15000);
					if (wc.code !== 0 || String(wc.stdout).trim() !== 'true') {
						logLine(`pair/checkout 前置检查失败: repo=${repo} code=${wc.code} out=${JSON.stringify(wc.stdout)} err=${JSON.stringify(wc.stderr)}`);
						json(res, FAIL({ code: 'not-git', message: '插件目录不是 git 仓库（可能是复制安装），无法自动切换版本。请使用下方高级命令手动升级。', diag: { repo, code: wc.code, out: String(wc.stdout).slice(0, 120), err: String(wc.stderr).slice(0, 120) } }), 409);
						return;
					}
					const fe = await git('fetch origin --tags', 90000);
					if (fe.code !== 0) {
						json(res, FAIL({ code: 'fetch-failed', message: `拉取版本列表失败（${(String(fe.stderr || fe.stdout)).trim().split('\n')[0].slice(0, 120) || '网络错误'}）。请检查网络后重试，或使用高级命令手动升级。` }), 502);
						return;
					}
					const vt = await git(`rev-parse --verify refs/tags/${tag}`, 15000);
					if (vt.code !== 0) {
						json(res, FAIL({ code: 'not-found', message: `版本标签 ${tag} 不存在。请刷新页面后重试，或使用高级命令手动升级。` }), 404);
						return;
					}
					const st = await git('status --porcelain --untracked-files=no', 15000);
					if (String(st.stdout).trim()) {
						json(res, FAIL({ code: 'dirty', message: '插件目录有未提交的本地修改，为避免覆盖请先处理（可用 git status 查看）后再重试。' }), 409);
						return;
					}
					const before = (await git('rev-parse --short HEAD', 15000)).stdout.trim();
					const co = await git(`checkout --detach refs/tags/${tag}`, 60000);
					if (co.code !== 0) {
						json(res, FAIL({ code: 'checkout-failed', message: `切换版本失败（${(String(co.stderr || co.stdout)).trim().split('\n')[0].slice(0, 120) || '未知错误'}），插件目录未改动，可安全重试。` }), 409);
						return;
					}
					const after = (await git('rev-parse --short HEAD', 15000)).stdout.trim();
					logLine(`配对升级: 插件目录已切换到 ${tag}（${before} -> ${after}），重启 DSH 后生效`);
					await appendAudit({ kind: 'pair-checkout', tag, before, after });
					json(res, OK({ tag, before, after, note: '插件版本已切换，重启 DSH 后加载新插件。' }));
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
						emit('对当前清单组合做试运行验证（独立环境启动）...');
						const iso = await makeIsoJunctionHome('mverify', cfg);
						const t = await canaryTest({ entry: cfg.entry, isoHome: iso, workdir: cfg.workdir, label: 'manifest-verify', cfg });
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

				case '/dsh-safe-launch/setup/desktop-launcher': {
					try {
						const ob = await readOnboarding();
						if (ob.status === 'accepted') {
							json(res, OK({ alreadyAccepted: true, launcher: ob.launcher ?? '', shortcut: ob.shortcut ?? '' }));
							return;
						}
						const r = await setupDesktopLauncher((m) => logLine(`[setup] ${m}`));
						json(res, OK(r));
					} catch (error) {
						ctx.logger.warn?.(`dsh-safe-launch: setup failed: ${String(error?.message ?? error)}`);
						json(res, FAIL({ code: 'setup-failed', message: String(error?.message ?? error) }), 500);
					}
					return;
				}

				case '/dsh-safe-launch/setup/dismiss-onboarding': {
					const st = await writeOnboarding({ status: 'declined', declinedAt: new Date().toISOString() });
					await appendNotice('已选择暂不由插件接管启动/安装（纯插件模式）。随时可调用 POST /setup/desktop-launcher 开启。');
					logLine('用户选择暂不接管');
					json(res, OK(st));
					return;
				}

				case '/dsh-safe-launch/self-test': {
					const vers = Array.isArray(payload.versions) ? payload.versions : [];
					const r = startJob('self-test', (emit) => flowSelfTest(emit, vers));
					if (r.error) { json(res, FAIL(r.error), 409); return; }
					json(res, OK({ jobId: r.jobId }));
					return;
				}

				// 配置面板：自包含 HTML，任何 dsh 版本可用（纯自有路由）。
				// 展示：引导同意卡片（创建桌面启动器）、dsh/插件更新提示与一键测试安装、
				// 启动器状态、清单漂移状态、已装插件清单。
				// 面板红色按钮：显式关闭本实例（shutdownOnUiClose 开启时面板会禁用该按钮）
				case '/dsh-safe-launch/shutdown': {
					const cfgS = await readLastGood();
					if (!cfgS) { json(res, FAIL(BAD_REQUEST), 400); return; }
					await appendNotice('用户通过设置页关闭了 DSH 服务器。');
					json(res, OK({ shuttingDown: true }));
					// 让响应先送达浏览器，再终止监听进程树
					setTimeout(() => {
						(async () => {
							try {
								const pids = await netstatListenPids(cfgS.port);
								for (const pid of pids) {
									await new Promise((res2) => {
										const k = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
										k.on('close', res2); k.on('error', res2);
									});
								}
							} catch {}
							setTimeout(() => process.exit(0), 600).unref?.();
						})();
					}, 400).unref?.();
					return;
				}
				case '/dsh-safe-launch/heartbeat': {
					noteHeartbeat(payload.tabId, payload.event || 'alive');
					json(res, OK({ tracked: uiHeartbeats.size }));
					return;
				}

				case '/dsh-safe-launch/config/shutdown-on-ui-close': {
					const val = payload.value === true;
					const cfgX = await readLastGood();
					if (!cfgX) { json(res, FAIL(BAD_REQUEST), 400); return; }
					cfgX.shutdownOnUiClose = val;
					await saveLastGood(cfgX, 'shutdown-on-ui-close', String(val));
					if (settingsScopeRef && typeof settingsScopeRef.update === 'function') {
						Promise.resolve(settingsScopeRef.update({ shutdownOnUiClose: val })).catch(() => {});
					}
					json(res, OK({ shutdownOnUiClose: val }));
					return;
				}
				case '/dsh-safe-launch/boot-shape/current': {
					const cfg = await ensureConfig();
					json(res, OK({ template: bootTemplateOf(cfg), resolved: resolveBootArgs(cfg), port: cfg.port }));
					return;
				}

				// 验证一个启动形状（隔离试运行，随机端口）并通过后保存为该机器的
				// 启动模板 —— 旧版/异形 dsh 的适配入口。
				case '/dsh-safe-launch/boot-shape/set': {
					if (!Array.isArray(payload.args) || payload.args.length === 0 || !payload.args.every((x) => typeof x === 'string' && x.length <= 200)) {
						json(res, FAIL(BAD_REQUEST), 400); return;
					}
					const template = payload.args.map(String).slice(0, 40);
					try {
						const cfg0 = await ensureConfig();
						const iso = await makeIsoJunctionHome('bootshape', cfg0);
						const t = await canaryTest({ entry: cfg0.entry, isoHome: iso, workdir: cfg0.workdir, label: 'bootshape', cfg: { ...cfg0, bootArgs: template } });
						if (!t.ok) { json(res, FAIL({ code: 'verify-failed', message: `候选形状验证未通过: ${t.detail}` }), 400); return; }
						cfg0.bootArgs = template;
						await saveLastGood(cfg0, 'bootshape-set', template.join(' '));
						await appendNotice(`启动命令形状已更新并验证通过: ${template.join(' ')}`);
						json(res, OK({ saved: true, template }));
					} catch (error) {
						ctx.logger.warn?.(`dsh-safe-launch: boot-shape/set failed: ${String(error?.message ?? error)}`);
						json(res, FAIL({ code: 'internal', message: String(error?.message ?? error) }), 500);
					}
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

/** Dormant mode: host dsh is outside our supported range. Register ONLY an
 * explanatory endpoint so AI/user can see why, and never break boot. */
function registerDormantRoutes(ctx, verdict) {
	try {
		const handler = async (req, res) => {
			json(res, OK({
				dormant: true,
				reason: verdict.reason,
				dshVersion: verdict.dshVersion,
				supported: { min: DSH_COMPAT.min, max: DSH_COMPAT.max },
				hint: verdict.hint
			}));
		};
		ctx.webServer.register({ kind: 'prefix', path: '/dsh-safe-launch', handler });
		logLine(`休眠模式路由已注册（仅 /dsh-safe-launch/* 说明端点）`);
	} catch (e) {
		logLine(`休眠路由注册失败(忽略): ${e.message}`);
	}
}

function assessCompat(dshVersion) {
	const hintBase = '请通过 dsh plugin add 更新本插件，或调整 dsh 版本。当前实例不受影响。';
	if (!dshVersion) return { ok: true, dshVersion }; // 无法判定时按可用处理（不因未知而停用）
	// v0.2.2 default-open：不再因"版本太旧"停用（未知旧版默认兼容）。
	// 只有 max 上界（已知不良的 dsh 版本线，由发布流程实测后设置）才会触发休眠。
	if (DSH_COMPAT.max && cmpSemver(dshVersion, DSH_COMPAT.max) >= 0) {
		return { ok: false, dshVersion, reason: `dsh ${dshVersion} 超出本插件已验证的上限 ${DSH_COMPAT.max}`, hint: hintBase };
	}
	return { ok: true, dshVersion };
}

let dormantVerdict = null;

/** Guarded bootstrap: version gate first; any activation error degrades to a
 * notice instead of failing the whole dsh boot. */
async function bootstrapRoutesGuarded(ctx) {
	let ver = '';
	try {
		const self = await selfEntryInfo();
		ver = String(process.env.DSH_SL_ASSUME_DSH_VERSION || '').trim() || (self?.version ?? '');
	} catch {}
	const verdict = assessCompat(ver);
	if (!verdict.ok) {
		dormantVerdict = verdict;
		logLine(`兼容性门禁: ${verdict.reason} —— 插件进入休眠模式（不注册任何功能，不影响启动）`);
		await appendNotice(`dsh-safe-launch 已自动停用：${verdict.reason}。${verdict.hint}`);
		registerDormantRoutes(ctx, verdict);
		return;
	}
	try {
		await registerRoutes(ctx);
	} catch (e) {
		logLine(`路由注册异常，已降级为休眠模式(不影响启动): ${e.message}`);
		await appendNotice(`dsh-safe-launch 激活失败并已安全降级：${e.message}。其余功能不受影响，请检查插件/dsh 版本兼容性。`);
		try { registerDormantRoutes(ctx, { ok: false, dshVersion: ver, reason: '激活异常', hint: e.message }); } catch {}
	}
}

const inject = ['webServer', 'settings'];

// ---- 设置命名空间（v0.5.1）：让「设置 → 插件」页出现本插件卡片，并把
// shutdownOnUiClose 作为可编辑项在 命名空间 ⇄ last-good.json 之间双向同步 ----
const SETTINGS_NS = 'dsh-safe-launch';
/** 零依赖 schema：满足 dsh-settings 的三类用法 —— 可调用解析、toJSON()、
 * redactSecrets 的 walk()（type/dict/meta 节点形状）。不引入 schemastery：
 * 实测加载器对第三方裸导入 @deepseek-ai/* 解析不可靠，会导致模块静默加载失败。 */
function makeSettingsSchema() {
	const fields = {
		shutdownOnUiClose: { type: 'boolean', meta: {} },
	};
	const resolve = (raw) => {
		const v = raw && typeof raw === 'object' ? raw : {};
		return { shutdownOnUiClose: v.shutdownOnUiClose === true };
	};
	resolve.type = 'object';
	resolve.meta = {};
	resolve.dict = fields;
	resolve.toJSON = () => ({ type: 'object', dict: fields });
	return resolve;
}
const SETTINGS_SCHEMA = makeSettingsSchema();
let settingsScopeRef = null;

async function syncShutdownSetting(desired) {
	const cfg = await readLastGood();
	if (!cfg) return;
	if ((cfg.shutdownOnUiClose === true) !== desired) {
		cfg.shutdownOnUiClose = desired;
		await saveLastGood(cfg, 'settings-sync', String(desired));
	}
}

async function registerSettingsNamespace(ctx) {
	const scope = ctx.settings.register(SETTINGS_NS, SETTINGS_SCHEMA);
	settingsScopeRef = scope;
	try {
		const cfg = await readLastGood();
		const wanted = { shutdownOnUiClose: cfg ? cfg.shutdownOnUiClose === true : false };
		const cur = scope.get?.() ?? {};
		if ((cur.shutdownOnUiClose === true) !== wanted.shutdownOnUiClose) {
			await scope.update(wanted);
		}
	} catch (e) {
		logLine(`设置命名空间初值同步跳过: ${e.message}`);
	}
	if (typeof scope.watch === 'function') {
		scope.watch((v) => {
			syncShutdownSetting((v && v.shutdownOnUiClose) === true)
				.catch((e) => logLine(`设置同步失败: ${e.message}`));
		});
	}
	logLine(`设置命名空间已注册: ${SETTINGS_NS}`);
}

function apply(ctx) {
	ctx.effect(() => bootstrapRoutesGuarded(ctx), 'dsh-safe-launch: guarded routes');
	ctx.effect(() => registerSettingsNamespace(ctx), 'dsh-safe-launch: settings namespace');
	ensureDir(SL_DIR).then(async () => {
		const cfg = await ensureConfig().catch(() => null);
		if (cfg) logLine(`safe-launch 就绪：当前配置 v${cfg.dshVersion} (${cfg.source})`);
		else logLine('safe-launch 就绪：暂无有效配置（首次调用接口时会自动引导）');
		if (!dormantVerdict) {
			startWatchdog().catch((e) => logLine(`自动巡检启动失败: ${e.message}`));
			waitForSelfHttp(120000)
				.then((up) => {
					if (!up) { logLine('网页未就绪，跳过启动更新检查'); return; }
					return startupUpdateNotice().then(() => prewarmPairUpdate());
				})
				.catch((e) => logLine(`启动更新检查等待失败(忽略): ${e.message}`));
			startUiCloseWatch(ctx);
		}
		readOnboarding().then((ob) => {
			if (ob.status === 'pending') {
				logLine('首次使用提示：如需由本插件接管 DSH 启动与插件安装（桌面快捷方式 + AI 安全约定），请在征得用户同意后调用 POST /dsh-safe-launch/setup/desktop-launcher；不需要则 POST /setup/dismiss-onboarding。');
			}
		}).catch(() => {});
	}).catch(() => {});
}

export { apply, inject };

// ---------------------------------------------------------------------------
// 配置面板（v0.4）：自包含控制页。不依赖宿主前端槽位系统，任何 dsh 版本可用。
// 展示引导同意、更新提示（dsh/插件）、启动器与自动巡检状态、插件清单；按钮直连本插件 API。
// ---------------------------------------------------------------------------
