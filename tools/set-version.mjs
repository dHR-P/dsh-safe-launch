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
 * 同步改写两处：package.json 的 version、lib/index.js 的 PKG_VERSION。
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

const [dshArg, ownArg] = process.argv.slice(2);
if (!dshArg) fail('用法: node tools/set-version.mjs <dshVersion> [pluginOwnVersion]\n例: node tools/set-version.mjs 0.1.1-rc.3 0.6.0');

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
writeFileSync(idxPath, idxText, 'utf8');

console.log('版本已更新:');
console.log('  package.json      version      ->', newVersion);
console.log('  lib/index.js      PKG_VERSION  ->', newVersion);
console.log('');
console.log('建议的人工步骤:');
console.log('  git commit -m "release: ' + newVersion + '"');
console.log('  git tag ' + newVersion + '   # 标签由你自行决定是否打');
