/**
 * dsh-safe-launch — client half (hand-written __ModuleLoader__ bundle).
 *
 * Settings card in Settings → plugin configuration (settings.plugin.item):
 *  - one-glance launcher state (version, takeover, port)
 *  - open full control panel / restart dsh / stop server buttons
 *
 * No build chain: served by client-modules at /plugins/dsh-safe-launch/client.js.
 * Every network call is failure-tolerant so this card can never break Settings,
 * on any dsh version that supports dsh.client (default-open policy).
 */
window.__ModuleLoader__.load({
	id: "dsh-safe-launch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ------------------------------------------------------------------
		// Locale
		// ------------------------------------------------------------------
		const NS = "dsh-safe-launch";
		const zh = {
			title: "安全启动器",
			desc: "桌面快捷方式启动 · 更新需插件同意并试运行 · 自动巡检兼容性"
		};
		const en = {
			title: "Safe Launch",
			desc: "Last-good boot, consent-gated canary updates, watchdog verification"
		};

		// ------------------------------------------------------------------
		// Styles (injected once; stable non-hash classes)
		// ------------------------------------------------------------------
		const CSS = `
.dsh-safelaunch-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-base);
}
.dsh-safelaunch-title { font-size: 0.875rem; font-weight: 600; color: var(--dsw-alias-label-primary); display:flex; align-items:center; gap:8px; }
.dsh-safelaunch-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-safelaunch-desc { font-size: 0.75rem; color: var(--dsw-alias-label-secondary); }
.dsh-safelaunch-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-safelaunch-kv { font-size: 0.75rem; color: var(--dsw-alias-label-primary); }
.dsh-safelaunch-kv b { color: var(--dsw-alias-label-secondary); font-weight: 500; margin-right: 4px; }
.dsh-safelaunch-btn {
  font-size: 0.75rem; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-float);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px; padding: 4px 10px;
}
.dsh-safelaunch-btn:hover { border-color: var(--dsw-alias-state-business-primary); }
.dsh-safelaunch-btn[disabled] { opacity: .45; cursor: not-allowed; }
.dsh-safelaunch-btn-danger { color: #f87171; border-color: #7f1d1d; }
.dsh-safelaunch-msg { font-size: 0.72rem; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
.dsh-safelaunch-pair {
  margin-top: 4px; border: 1px solid #7f1d1d; border-radius: 8px;
  background: rgba(127,29,29,.12);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
}
.dsh-safelaunch-pair-title { font-size: 0.8rem; font-weight: 600; color: #f87171; }
.dsh-safelaunch-cmd {
  font-size: 0.72rem; font-family: Consolas, Menlo, monospace;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-float);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  padding: 8px 10px; max-height: 220px; overflow: auto; white-space: pre-wrap;
  margin: 0;
}
.dsh-safelaunch-details summary { cursor: pointer; font-size: 0.72rem; color: var(--dsw-alias-label-secondary); }
.dsh-safelaunch-details { margin-top: 2px; }
.dsh-safelaunch-step { font-size: 0.75rem; color: #f8b26a; white-space: pre-wrap; }
`;
		let cssDone = false;
		function injectCss() {
			if (cssDone) return;
			cssDone = true;
			try {
				const el = document.createElement("style");
				el.textContent = CSS;
				document.head.appendChild(el);
			} catch {}
		}

		async function api(path, body) {
			const res = await fetch("/dsh-safe-launch/" + path, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? {} : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const ct = String(res.headers.get("content-type") || "");
			const data = ct.includes("json") ? await res.json().catch(() => null) : null;
			if (!res.ok || !data || data.ok !== true) {
				throw new Error((data && data.error && data.error.message) || ("HTTP " + res.status));
			}
			return data.value;
		}

		function fallbackCopy(text) {
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
			} catch {}
		}

		function copyText(text) {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
			} else {
				fallbackCopy(text);
			}
		}

		// ------------------------------------------------------------------
		// Settings card component
		// ------------------------------------------------------------------
		function SafeLaunchSettingsCard() {
			const [st, setSt] = react.useState(null);
			const [msg, setMsg] = react.useState("");
			const [busy, setBusy] = react.useState("");

			react.useEffect(() => {
				let alive = true;
				api("status").then((v) => { if (alive) setSt(v); }).catch(() => { if (alive) setSt({ offline: true }); });
				api("status", { network: true }).then((v) => { if (alive) setSt(v); }).catch(() => {});
				return () => { alive = false; };
			}, []);

			const run = async (label, path, body, confirmText) => {
				if (confirmText && !window.confirm(confirmText)) return;
				setBusy(label); setMsg("");
				try {
					await api(path, body || {});
					setMsg(label + " 指令已发送。");
					if (path === "status" || path.indexOf("config/") === 0 || path.indexOf("setup/") === 0) { const v = await api("status"); setSt(v); }
				} catch (e) {
					setMsg(label + " 失败：" + (e && e.message ? e.message : e));
				} finally {
					setBusy("");
				}
			};

			const [pairStep, setPairStep] = react.useState("");

			// 一键配对升级：由浏览器分步驱动（服务端任务无法跨重启存活）。
			// ①切换插件 tag → ②请求重启（连接会断开，属正常）→ ③轮询 ping 等待就绪
			// → ④后台试运行新 dsh 并轮询 job；任一步失败都保持当前实例不受影响。
			const runPairUpgrade = async (cu) => {
				if (!window.confirm("将自动完成 4 步：① 切换插件版本 ② 重启 DSH ③ 等待 DSH 恢复 ④ 后台试运行新 DSH 并保存为启动配置。\n\n期间请保持本页面打开（不要刷新或关闭）。确定开始？")) return;
				setBusy("一键升级"); setMsg(""); setPairStep("");
				try {
					setPairStep("步骤 1/4：从 GitHub 拉取并切换插件到适配版本 " + cu.pluginVersion + " …");
					await api("pair/checkout", { tag: cu.pluginTag });
					setPairStep("步骤 2/4：重启 DSH 以加载新插件（页面会短暂断开，属正常现象）…");
					await api("restart").catch(() => {});
					setPairStep("步骤 3/4：等待 DSH 自动重启完成…");
					const base = "http://" + (st.host || "127.0.0.1") + ":" + (st.port || 3080);
					let ready = false;
					for (let i = 0; i < 80 && !ready; i++) {
						await new Promise((r) => setTimeout(r, 3000));
						try { const r = await fetch(base + "/dsh-safe-launch/ping"); if (r.status === 200) ready = true; } catch {}
					}
					if (!ready) throw new Error("4 分钟内未检测到 DSH 恢复。插件已切换；请刷新页面查看。若需回退，可在插件目录执行 git checkout 原版本后重启。");
					setPairStep("步骤 4/4：后台试运行新 DSH " + cu.dshLatest + "（通过后自动保存，不影响当前实例）…");
					const j = await api("test-candidate", { version: cu.dshLatest });
					let done = false, outcome = "";
					for (let i = 0; i < 150 && !done; i++) {
						await new Promise((r) => setTimeout(r, 4000));
						const s = await api("job", { id: j.jobId });
						if (s.status === "done") { done = true; outcome = (s.result && s.result.version) || cu.dshLatest; }
						else if (s.status === "error") { done = true; throw new Error("试运行未通过：" + (s.error || "未知错误") + "（已保留旧配置，不影响当前使用）"); }
					}
					if (!done) throw new Error("试运行超过 10 分钟未完成，请到插件日志查看结果（当前配置未受影响）。");
					setMsg("升级完成：DSH " + outcome + " 已试运行通过并保存为下次启动配置，重启后生效。");
					const v = await api("status"); setSt(v);
				} catch (e) {
					setMsg("一键升级中断：" + (e && e.message ? e.message : e) + "（当前实例未受影响，可重试或使用下方高级命令）");
				} finally {
					setBusy(""); setPairStep("");
				}
			};

			const rows = [];
			if (!st) {
				rows.push(react.createElement("div", { key: "l", className: "dsh-safelaunch-desc" }, "读取状态中…"));
			} else if (st.offline) {
				rows.push(react.createElement("div", { key: "o", className: "dsh-safelaunch-desc" },
					"端点不可达：当前 dsh 版本可能未加载本插件，或实例早于插件安装。"));
			} else {
				rows.push(react.createElement("div", { key: "v", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "插件版本"), String(st.selfVersion || "-")));
				rows.push(react.createElement("div", { key: "d", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "dsh 版本"), String(st.dshVersion || "-"),
					"　", react.createElement("b", null, "端口"), String(st.port ?? "-")));
				if (st.latest) {
					rows.push(react.createElement("div", { key: "sup", className: "dsh-safelaunch-kv" },
						react.createElement("b", null, "最新 dsh 版本"), String(st.latest),
						"　", st.supportsLatest === true
							? react.createElement("span", { style: { color: "#2ea44f" } }, "✅ 本插件已适配")
							: react.createElement("span", { style: { color: "#f8b26a" } }, "⚠ 尚未适配（请先更新本插件）")));
				}
				if (st.launcher) {
				rows.push(react.createElement("div", { key: "t", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "桌面快捷方式"),
					"已创建 —— 双击桌面「DSH 安全启动」即可弹窗诊断并启动"));
			} else {
				rows.push(react.createElement("div", { key: "t", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "桌面快捷方式"),
					"未创建"));
				rows.push(react.createElement("div", { key: "t2", className: "dsh-safelaunch-row" },
					react.createElement("button", {
						className: "dsh-safelaunch-btn dsh-safelaunch-btn-primary",
						disabled: !!busy,
						onClick: () => run("创建桌面快捷方式", "setup/desktop-launcher", {}),
					}, busy === "创建桌面快捷方式" ? "创建中…" : "一键创建桌面快捷方式（推荐）")));
			}
				rows.push(react.createElement("div", { key: "u", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "关网页即关服"),
					st.shutdownOnUiClose === true ? "已开启" : "关闭"));

			if (st.combinedUpdate && st.combinedUpdate.available === true) {
				const cu = st.combinedUpdate;
				rows.push(react.createElement("div", { key: "pair", className: "dsh-safelaunch-pair" },
					react.createElement("div", { className: "dsh-safelaunch-pair-title" }, "🔔 有配套新版本，可一键升级"),
					react.createElement("div", { className: "dsh-safelaunch-desc" },
						"DSH 有新版本 " + cu.dshLatest + "，需要先把「安全启动器」升级到 " + cu.pluginVersion +
						"（这个插件版本就是适配新 DSH 的版本）。点下方按钮自动完成：升级插件 → 重启 → 试运行 → 保存配置，全程无需手动操作。"),
					pairStep ? react.createElement("div", { className: "dsh-safelaunch-step" }, pairStep) : null,
					react.createElement("div", { className: "dsh-safelaunch-row" },
						react.createElement("button", {
							className: "dsh-safelaunch-btn dsh-safelaunch-btn-primary",
							disabled: !!busy,
							onClick: () => runPairUpgrade(cu),
						}, busy === "一键升级" ? "升级中…" : "一键升级（自动完成）")),
					react.createElement("details", { className: "dsh-safelaunch-details" },
						react.createElement("summary", null, "高级选项：查看/复制手动升级命令"),
						react.createElement("pre", { className: "dsh-safelaunch-cmd" }, cu.upgradeCmd),
						react.createElement("div", { className: "dsh-safelaunch-row" },
							react.createElement("button", {
								className: "dsh-safelaunch-btn",
								disabled: !!busy,
								onClick: () => { copyText(cu.upgradeCmd); setMsg("手动升级命令已复制，可在 PowerShell 中执行。"); },
							}, "复制命令")))));
			}

			if (Array.isArray(st.incompatiblePlugins) && st.incompatiblePlugins.length > 0) {
				rows.push(react.createElement("div", { key: "inc", className: "dsh-safelaunch-kv" },
					react.createElement("b", { style: { color: "#e5534b" } }, "不兼容插件"),
					react.createElement("span", { style: { color: "#e5534b" } }, String(st.incompatiblePlugins.join("、")) +
						"（本次启动已回退排除，测试通过后自动启用）")));
			}
			if (st.lastDiagnosis && st.lastDiagnosis.at) {
				const ld = st.lastDiagnosis;
				rows.push(react.createElement("div", { key: "diag", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "上次启动诊断"),
					String((ld.ok ? "通过" : "失败") + (ld.usedFallback ? "（已回退）" : "") +
						" · " + new Date(String(ld.at)).toLocaleString())));
			}
			rows.push(react.createElement("div", { key: "cfg", className: "dsh-safelaunch-row" },
				react.createElement("label", { style: { cursor: "pointer", display: "inline-flex", gap: "6px", alignItems: "center" } },
					react.createElement("input", {
						type: "checkbox",
						checked: st.shutdownOnUiClose === true,
						disabled: !!busy,
						onChange: (e) => run(e.target.checked ? "开启关网页即关服" : "关闭关网页即关服",
							"config/shutdown-on-ui-close", { value: e.target.checked }),
					}),
					" 关网页即关服务器（所有页面关闭约15秒后自动退出）")));
			}

			return react.createElement("div", { className: "dsh-safelaunch-card" },
				react.createElement("div", { className: "dsh-safelaunch-title" },
					"🛡️ ", zh.title,
					react.createElement("span", { className: "dsh-safelaunch-badge" }, "v" + ((st && st.selfVersion) || "?"))),
				react.createElement("div", { className: "dsh-safelaunch-desc" }, zh.desc),
				...rows,
				react.createElement("div", { className: "dsh-safelaunch-row" },
				react.createElement("button", {
					className: "dsh-safelaunch-btn",
					disabled: !!busy,
					onClick: () => run("重启 DSH", "restart", {}, "确定重启 DSH？页面会短暂断开，稍后自动恢复。"),
				}, busy === "重启 DSH" ? "重启中…" : "重启 DSH"),
					react.createElement("button", {
						className: "dsh-safelaunch-btn dsh-safelaunch-btn-danger",
						disabled: !!busy || (st && st.shutdownOnUiClose === true),
						title: (st && st.shutdownOnUiClose === true)
							? "「关网页即关服务器」已开启：所有页面关闭时自动退出"
							: "",
						onClick: () => run("关闭服务器", "shutdown", {}, "确定关闭 DSH 服务器？之后可用桌面快捷方式重新启动。"),
					}, "⛔ 关闭服务器")),
				msg ? react.createElement("div", { className: "dsh-safelaunch-msg" }, msg) : null,
			);
		}

		// ------------------------------------------------------------------
		// Plugin apply
		// ------------------------------------------------------------------
		const inject = ["slots", "locale"];

		function apply(ctx) {
			injectCss();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-safe-launch: dictionaries");
			// 独立设置分区（与「插件」同级）：挂 settings.section 槽位，
			// 组件收 { close }，本卡片自绘内容、不依赖壳提供的 hooks。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "safe-launch",
				order: 16,
				label: () => (zh && zh.title) || "Safe Launch"
			}, SafeLaunchSettingsCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
