/**
 * dsh-safe-launch restart helper — detached restarter.
 *
 * Spawned detached by the plugin's /dsh-safe-launch/restart endpoint:
 *   node restart-helper.js <port>
 *
 * Sequence: grace pause (let the HTTP response flush) -> kill the dsh
 * listener tree on <port> -> wait until the port is free -> boot a fresh
 * instance from last-good.json -> verify health -> append a NOTICE line.
 * The parent dsh process never restarts itself; this helper outlives it.
 */
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import http from 'node:http';

const IS_WINDOWS = process.platform === 'win32';
const port = parseInt(process.argv[2] || '3080', 10);
const SL_DIR = join(
	process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
		? process.env.DSH_HOME
		: join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
	'safe-launch'
);
const NOTICE = join(SL_DIR, 'NOTICE.txt');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const notice = (m) => {
	try {
		mkdirSync(SL_DIR, { recursive: true });
		appendFileSync(NOTICE, `[${now()}] ${m}\n`);
	} catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function netstatListenPids(port2) {
	return new Promise((res) => {
		execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 8000 }, (err, stdout) => {
			const pids = new Set();
			for (const line of String(stdout || '').split('\n')) {
				if (/LISTENING/i.test(line) && new RegExp(`[:.]${port2}\\s`).test(line)) {
					const m = line.trim().split(/\s+/).pop();
					if (/^\d+$/.test(m)) pids.add(parseInt(m, 10));
				}
			}
			res([...pids]);
		});
	});
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

function httpOkOnce(url, timeoutMs = 3000) {
	return new Promise((res) => {
		const req = http.get(url, { timeout: timeoutMs }, (r) => { r.resume(); res(r.statusCode >= 200 && r.statusCode < 300); });
		req.on('timeout', () => { req.destroy(); res(false); });
		req.on('error', () => res(false));
	});
}

async function waitHttpOk(url, maxSeconds) {
	const deadline = Date.now() + maxSeconds * 1000;
	while (Date.now() < deadline) {
		if (await httpOkOnce(url)) return true;
		await sleep(600);
	}
	return false;
}

async function main() {
	await sleep(1200); // grace: let the triggering HTTP response reach the caller
	notice(`restart-helper: 开始重启流程 (port=${port})`);

	for (let round = 0; round < 3; round++) {
		const pids = await netstatListenPids(port);
		if (pids.length === 0) break;
		for (const pid of pids) await killTree(pid);
		await sleep(800);
	}
	const freeDeadline = Date.now() + 20000;
	while (Date.now() < freeDeadline) {
		if ((await netstatListenPids(port)).length === 0) break;
		await sleep(500);
	}

	let cfg;
	try {
		cfg = JSON.parse(await readFile(join(SL_DIR, 'last-good.json'), 'utf8'));
	} catch {
		notice('restart-helper: 失败 — 无法读取 last-good.json');
		process.exit(1);
	}
	if (!existsSync(cfg.entry)) {
		notice(`restart-helper: 失败 — 入口不存在: ${cfg.entry}`);
		process.exit(1);
	}

	const args = [`"${cfg.entry}"`, 'web', '--host', cfg.host || '127.0.0.1', '--port', String(cfg.port), '--no-open'];
	for (const a of cfg.extraArgs || []) args.push(String(a));
	const child = spawn(process.execPath, args, {
		cwd: cfg.workdir,
		detached: true,
		stdio: 'ignore',
		windowsHide: true
	});
	child.unref();

	const ok = await waitHttpOk(`http://${cfg.host || '127.0.0.1'}:${cfg.port}/`, 90);
	if (ok) {
		notice(`restart-helper: 重启成功，运行 v${cfg.dshVersion}（entry=${cfg.entry}）`);
		process.exit(0);
	}
	notice('restart-helper: 重启后健康检查失败！可用 rollback-config 回退配置后重试。');
	process.exit(1);
}

main();
