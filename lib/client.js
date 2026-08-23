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
			desc: "桌面接管启动 · 同意制金丝雀更新 · 看门狗兼容性验证"
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
				return () => { alive = false; };
			}, []);

			const run = async (label, path, body, confirmText) => {
				if (confirmText && !window.confirm(confirmText)) return;
				setBusy(label); setMsg("");
				try {
					await api(path, body || {});
					setMsg(label + " 指令已发送。");
					if (path === "status") { const v = await api("status"); setSt(v); }
				} catch (e) {
					setMsg(label + " 失败：" + (e && e.message ? e.message : e));
				} finally {
					setBusy("");
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
				rows.push(react.createElement("div", { key: "t", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "桌面接管"),
					st.launcher && st.launcher.installed
						? "已接管（快捷方式就绪）"
						: "未接管——可在控制面板完成引导"));
				rows.push(react.createElement("div", { key: "u", className: "dsh-safelaunch-kv" },
					react.createElement("b", null, "关网页即关服"),
					st.shutdownOnUiClose === true ? "已开启" : "关闭"));
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
						onClick: () => { try { window.open("/dsh-safe-launch/panel", "_blank"); } catch {} },
					}, "打开控制面板"),
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
			// Settings card (root scope — register at the plugin level).
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				id: "dsh-safe-launch",
				order: 120,
				locale: NS
			}, SafeLaunchSettingsCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
