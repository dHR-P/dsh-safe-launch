#!/usr/bin/env node
/**
 * boot-prep.mjs — 桌面启动器在拉起 dsh 之前运行的「按已验证清单组装」步骤。
 *
 * 数据来源：
 *   <store>/last-good.json 的 profileManifest.bundles —— 上次通过兼容性验证的插件清单
 * 目标：
 *   <home>/profiles/<name>/package.json 的 dsh.profile.bundles
 *
 * 规则（用户约定）：
 *   - 验证清单里、当前也存在的插件 → 正常装配；
 *   - 当前存在但不在验证清单里的（AI 绕过启动器新装的）→ 本此启动先排除，
 *     写入 pending-candidates.json 由插件侧看门狗后台金丝雀测试后决定采纳；
 *   - 验证清单里有、但已被卸载的 → 「卸了就卸了」，从验证清单除名并记录审计。
 *
 * 用法：node boot-prep.mjs --store <safe-launch目录> [--profile web]
 * 任何异常都不阻断 dsh 启动（退出码恒为 0，仅打印原因）。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

function argOf(name) {
	const a = process.argv.slice(2);
	const i = a.indexOf('--' + name);
	return i >= 0 ? a[i + 1] : undefined;
}

const store = resolve(argOf('store') || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'safe-launch'));
const lgPath = join(store, 'last-good.json');

let lg = null;
try { lg = JSON.parse(readFileSync(lgPath, 'utf8')); } catch {}
if (!lg) { console.log('[boot-prep] 尚无 last-good.json（首次运行），跳过组装。'); process.exit(0); }

const profileName = argOf('profile') || lg.profileName || 'web';
const home = dirname(store);
const pDir = join(home, 'profiles', profileName);
const pkgPath = join(pDir, 'package.json');
if (!existsSync(pkgPath)) { console.log(`[boot-prep] 未找到 ${pkgPath}，跳过组装。`); process.exit(0); }

let pkg;
try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch (e) { console.log(`[boot-prep] package.json 解析失败（${e.message}），跳过组装。`); process.exit(0); }

const verified = Array.isArray(lg?.profileManifest?.bundles) ? lg.profileManifest.bundles.map(String) : [];
if (verified.length === 0) { console.log('[boot-prep] 无已验证清单，跳过组装（保持现状）。'); process.exit(0); }

const curBundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : [];
const depKeys = new Set(Object.keys(pkg?.dependencies ?? {}));
const installed = (name) => existsSync(join(pDir, 'node_modules', name));

// 卸了就卸了：验证清单里、当前 bundles 已不含且依赖也没了的 → 除名
const dropped = verified.filter((b) => !curBundles.includes(b) && !depKeys.has(b));
const keep = verified.filter((b) => !dropped.includes(b));
// 待测候选：AI 新装、尚不在验证清单的
const candidates = curBundles.filter((b) => !keep.includes(b));

if (dropped.length === 0 && candidates.length === 0) {
	console.log('[boot-prep] 清单与已验证基线一致，无需调整。');
	process.exit(0);
}

pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
pkg.dsh.profile.bundles = keep;
try {
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
} catch (e) {
	console.log(`[boot-prep] 写回失败（${e.message}），保持原状启动。`);
	process.exit(0);
}

try {
	const line = JSON.stringify({ at: new Date().toISOString(), kind: 'boot-prep', dropped, candidates }) + '\n';
	appendFileSync(join(store, 'audit.jsonl'), line);
} catch {}

if (candidates.length > 0) {
	try {
		writeFileSync(join(store, 'pending-candidates.json'), JSON.stringify({ added: candidates, dropped, at: new Date().toISOString() }, null, 2));
	} catch {}
}

console.log(`[boot-prep] 本次按已验证清单装配 ${keep.length} 个 bundles。`);
if (dropped.length > 0) console.log(`[boot-prep] 已卸载除名: ${dropped.join(', ')}`);
if (candidates.length > 0) console.log(`[boot-prep] 新增候选延后测试: ${candidates.join(', ')}（本次不装载）`);
