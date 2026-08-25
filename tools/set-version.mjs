#!/usr/bin/env node
/**
 * set-version.mjs — dsh-safe-launch 发布版本命名助手。
 *
 * 命名规则：<适配的dsh版本>-v<插件自身版本>
 *   例：dsh 0.1.1-rc.2 + 插件自身 0.5.0  →  0.1.1-rc.2-v0.5.0
 *
 * 用法：
 *   node tools/set-version.mjs <dshVersion> [pluginOwnVersion]
 *   node tools/set-version.mjs 0.1.1-rc.3            # 自有版本沿用当前值
 *   node tools/set-version.mjs 0.1.1-rc.3 0.6.0      # 同时提升自有版本（v 可省略）
 *
 * 同步改写：package.json 的 version、lib/index.js 的 PKG_VERSION；
 * 可选 --tested <dshVersion>：同步更新 dsh 兼容覆盖声明
 *   （package.json dsh.compat.tested 与 lib/index.js DSH_COMPAT.tested）。
 * 其余显示位（面板 / 设置卡片）都读 selfVersion，自动跟随。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DSH_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const OWN_RE = /^v?(\d+\.\d+\.\d+)$/;

function fail(msg) {
	console.error('set-version: ' + msg);
	process.exit(1);
}

const argv = process.argv.slice(2);
let dshArg, ownArg, testedArg;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--tested') { testedArg = argv[++i]; continue; }
	if (dshArg === undefined) dshArg = argv[i];
	else if (ownArg === undefined) ownArg = argv[i];
}
if (!dshArg) fail('用法: node tools/set-version.mjs <dshVersion> [pluginOwnVersion] [--tested <dshVersion>]\n例: node tools/set-version.mjs 0.1.1-rc.3 0.6.0 --tested 0.1.1-rc.3');

const mDsh = DSH_RE.exec(String(dshArg).trim());
if (!mDsh) fail(`dshVersion "${dshArg}" 不合法（需 x.y.z[-prerelease]，可带 v 前缀）`);
const dshVersion = mDsh[1];

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = String(pkg.version ?? '');
let own;
if (ownArg !== undefined) {
	const mOwn = OWN_RE.exec(String(ownArg).trim());
	if (!mOwn) fail(`pluginOwnVersion "${ownArg}" 不合法（需 v?x.y.z）`);
	own = mOwn[1];
} else {
	const mCur = /-v(\d+\.\d+\.\d+)$/.exec(cur);
	if (!mCur) fail(`当前版本 "${cur}" 不符合 <dsh版本>-v<x.y.z> 规则，无法沿用自有版本号；请显式传入 pluginOwnVersion`);
	own = mCur[1];
}
const newVersion = `${dshVersion}-v${own}`;

// package.json：只替换 version 行，保持其余格式不动
let pkgText = readFileSync(pkgPath, 'utf8');
const pkgRe = /("version"\s*:\s*)"[^"]+"/;
if (!pkgRe.test(pkgText)) fail('package.json 中未找到 version 字段');
pkgText = pkgText.replace(pkgRe, `$1"${newVersion}"`);
writeFileSync(pkgPath, pkgText, 'utf8');

// lib/index.js：替换 PKG_VERSION 常量
const idxPath = join(ROOT, 'lib', 'index.js');
let idxText = readFileSync(idxPath, 'utf8');
const idxRe = /(const PKG_VERSION\s*=\s*)'[^']+'/;
if (!idxRe.test(idxText)) fail('lib/index.js 中未找到 PKG_VERSION 常量');
idxText = idxText.replace(idxRe, `$1'${newVersion}'`);

// 可选：同步 dsh 覆盖声明（tested）。未显式指定时默认推进到本次适配的 dshVersion。
const testedTarget = testedArg !== undefined ? testedArg : dshVersion;
const mTested = DSH_RE.exec(String(testedTarget).trim().replace(/^v/, ''));
if (!mTested) fail(`--tested 值 "${testedTarget}" 不合法`);
const testedVal = mTested[1];
{
	let t = readFileSync(pkgPath, 'utf8');
	const r1 = /("tested"\s*:\s*)"[^"]+"/;
	if (r1.test(t)) t = t.replace(r1, `$1"${testedVal}"`);
	else fail('package.json 中未找到 dsh.compat.tested 字段');
	writeFileSync(pkgPath, t, 'utf8');
	const r2 = /(const DSH_COMPAT = \{[^}]*tested:\s*)'[^']+'/;
	if (!r2.test(idxText)) fail('lib/index.js 中未找到 DSH_COMPAT.tested');
	idxText = idxText.replace(r2, `$1'${testedVal}'`);
}
writeFileSync(idxPath, idxText, 'utf8');

console.log('版本已更新:');
console.log('  package.json      version      ->', newVersion);
console.log('  lib/index.js      PKG_VERSION  ->', newVersion);
console.log('  dsh 覆盖声明 tested           ->', testedVal);
console.log('');
console.log('建议的人工步骤:');
console.log('  git commit -m "release: ' + newVersion + '"');
console.log('  git tag ' + newVersion + '   # 标签由你自行决定是否打');
