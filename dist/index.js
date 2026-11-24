var edaEsbuildExportName = (function () {
	"use strict";

	// ─────────────────────────── 常量 ───────────────────────────
	var EXT_VERSION = "0.1.5";
	var PROTOCOL_VERSION = 1;
	var SERVICE = "fuliforge-bridge";
	var HUB_MARK = "fuliforge-hub";
	var WS_PATH = "/fuliforge";
	var PORT_START = 49650;
	var PORT_END = 49659;
	var CONNECT_TIMEOUT_MS = 2500;
	var RETRY_BASE_MS = 3000;
	var RETRY_MAX_MS = 30000;
	var HEARTBEAT_MS = 10000;
	var SILENCE_TIMEOUT_MS = 90000;
	var PROBE_TIMEOUT_MS = 12000;
	var STORE_PORT = "fuliforge.bridge.port";
	var STORE_AUTOCONNECT = "fuliforge.bridge.autoconnect";
	var STORE_TARGET = "fuliforge.bridge.targetDir";

	// ─────────────────────────── 状态 ───────────────────────────
	var st = {
		connected: false,
		connecting: false,
		stopped: false,
		port: null,
		preferredPort: null,
		windowId: null,
		wsSeq: 0,
		curWsId: "",
		retry: 0,
		retryTimer: null,
		hbTimer: null,
		hbPendingSince: 0,
		lastRx: 0,
		gen: 0,
		lastMsgAt: 0,
		rxCount: 0,
		txCount: 0,
		portWaiters: {}
	};

	// ─────────────────────────── 基础工具 ───────────────────────────
	function msg(e) {
		return e instanceof Error ? e.message : String(e);
	}

	function toast(text) {
		try {
			if (eda && eda.sys_Message && eda.sys_Message.showToastMessage) {
				eda.sys_Message.showToastMessage(text);
			}
		} catch (e) { /* 提示失败不影响主流程 */ }
	}

	function info(text) {
		try {
			if (eda && eda.sys_Dialog && eda.sys_Dialog.showInformationMessage) {
				eda.sys_Dialog.showInformationMessage(text, "FuliForge Bridge");
			}
		} catch (e) { /* 同上 */ }
	}

	function debug(text, payload) {
		try {
			if (payload === undefined) {
				console.log("[fuliforge] " + text);
			} else {
				console.log("[fuliforge] " + text, payload);
			}
		} catch (e) { /* ignore */ }
	}

	/** 把任意返回值压成可 JSON 化的纯数据，防止循环引用/原型方法/超大对象 */
	function plain(value, depth, seen) {
		depth = depth === undefined ? 6 : depth;
		seen = seen || [];
		if (value === null || value === undefined) return null;
		var t = typeof value;
		if (t === "string" || t === "number" || t === "boolean") return value;
		if (t === "function") return undefined;
		if (t === "symbol") return String(value);
		if (t === "bigint") return String(value);
		if (depth <= 0) return "[max-depth]";
		if (Object.prototype.toString.call(value) === "[object Date]") return value.toISOString();
		if (Array.isArray(value)) {
			var arr = [];
			var n = Math.min(value.length, 300);
			for (var i = 0; i < n; i++) {
				var item = plain(value[i], depth - 1, seen);
				arr.push(item === undefined ? null : item);
			}
			if (value.length > n) arr.push("[+" + (value.length - n) + " more]");
			return arr;
		}
		if (t === "object") {
			for (var s = 0; s < seen.length; s++) if (seen[s] === value) return "[circular]";
			seen.push(value);
			var out = {};
			var keys;
			try { keys = Object.keys(value); } catch (e) { keys = []; }
			var kn = Math.min(keys.length, 80);
			for (var k = 0; k < kn; k++) {
				var key = keys[k];
				var v;
				try { v = plain(value[key], depth - 1, seen); } catch (e) { v = "[throws]"; }
				if (v !== undefined) out[key] = v;
			}
			if (keys.length > kn) out["_moreKeys"] = keys.length - kn;
			seen.pop();
			return out;
		}
		return String(value);
	}

	/** 取类实例的方法名：ES class 方法不可枚举，for...in 拿不到，必须沿原型链取属性名 */
	function methodNames(obj) {
		var out = [];
		var o = obj;
		var depth = 0;
		while (o && depth < 5) {
			var names = [];
			try { names = Object.getOwnPropertyNames(o); } catch (e) { names = []; }
			for (var i = 0; i < names.length; i++) {
				var k = names[i];
				if (k === "constructor" || out.indexOf(k) >= 0) continue;
				try {
					if (typeof obj[k] === "function") out.push(k);
				} catch (e) { /* getter 抛错则跳过 */ }
			}
			try { o = Object.getPrototypeOf(o); } catch (e) { o = null; }
			depth += 1;
		}
		return out.sort();
	}

	/** 判断 eda 上的 API 是否存在，例如 "eda.pcb_Drc.getAllRuleConfigurations" */
	function hasApi(path) {
		try {
			var parts = String(path).replace(/^eda\./, "").split(".");
			var obj = eda;
			for (var i = 0; i < parts.length; i++) {
				if (obj === null || obj === undefined) return false;
				obj = obj[parts[i]];
			}
			return typeof obj === "function" || (typeof obj === "object" && obj !== null);
		} catch (e) {
			return false;
		}
	}

	function apiState(path) {
		return hasApi(path) ? "ok" : "missing";
	}

	function safeName(text) {
		var s = String(text === null || text === undefined ? "" : text);
		s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, "_");
		s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
		return s || "item";
	}

	function joinPath(dir, name) {
		var d = String(dir || "");
		if (!d) return name;
		var sep = d.indexOf("\\") >= 0 ? "\\" : "/";
		if (d.charAt(d.length - 1) === "\\" || d.charAt(d.length - 1) === "/") {
			d = d.slice(0, -1);
		}
		return d + sep + name;
	}

	async function defaultTargetDir() {
		var stored = null;
		try {
			stored = eda.sys_Storage.getExtensionUserConfig(STORE_TARGET);
		} catch (e) { stored = null; }
		if (typeof stored === "string" && stored) return stored;
		var docs = "";
		try {
			if (eda.sys_FileSystem && eda.sys_FileSystem.getDocumentsPath) {
				// 实测这个接口返回 Promise，不 await 会得到 "[object Promise]"
				docs = String((await eda.sys_FileSystem.getDocumentsPath()) || "");
			}
		} catch (e) { docs = ""; }
		if (!docs) return "FuliForge/inbox/easyeda";
		return joinPath(docs, "FuliForge\\inbox\\easyeda");
	}

	function rememberTarget(dir) {
		try {
			if (dir) eda.sys_Storage.setExtensionUserConfig(STORE_TARGET, String(dir));
		} catch (e) { /* ignore */ }
	}

	// ─────────────────────────── WebSocket ───────────────────────────
	function nextWsId() {
		st.wsSeq += 1;
		return "fuliforge-" + st.wsSeq;
	}

	function registerPayload() {
		return {
			type: "register",
			service: SERVICE,
			protocolVersion: PROTOCOL_VERSION,
			extensionVersion: EXT_VERSION,
			windowId: st.windowId,
			port: st.port,
			capabilities: Object.keys(HANDLERS),
			title: currentDocumentTitle(),
			timestamp: Date.now()
		};
	}

	function sendRaw(obj) {
		try {
			if (!st.curWsId) return false;
			eda.sys_WebSocket.send(st.curWsId, JSON.stringify(obj));
			st.txCount += 1;
			return true;
		} catch (e) {
			debug("send failed: " + msg(e));
			// 发送失败＝链路已死；宿主没有 onClose 回调，只能靠这里发现
			if (st.connected) dropConnection("发送失败");
			return false;
		}
	}

	function reply(id, result) {
		// 深度 10：规则配置是 Spacing/Physics/Track/copperThickness1oz 这种 5-6 层嵌套，
		// 压得太浅会把真实数值变成 "[max-depth]"
		sendRaw({ type: "result", id: id, result: plain(result, 10), timestamp: Date.now() });
	}

	function replyError(id, error, extra) {
		sendRaw({
			type: "error",
			id: id,
			error: msg(error),
			detail: extra ? plain(extra, 4) : undefined,
			timestamp: Date.now()
		});
	}

	function portCandidates() {
		var list = [];
		var preferred = st.preferredPort;
		if (preferred) list.push(preferred);
		for (var p = PORT_START; p <= PORT_END; p++) {
			if (p !== preferred) list.push(p);
		}
		return list;
	}

	function readPreferredPort() {
		try {
			var v = Number(eda.sys_Storage.getExtensionUserConfig(STORE_PORT));
			if (v >= PORT_START && v <= PORT_END) return v;
		} catch (e) { /* ignore */ }
		return null;
	}

	function stopHeartbeat() {
		if (st.hbTimer) {
			clearInterval(st.hbTimer);
			st.hbTimer = null;
		}
	}

	function startHeartbeat() {
		stopHeartbeat();
		st.hbPendingSince = 0;
		st.hbTimer = setInterval(function () {
			if (!st.connected) return;
			// 上一轮探活没等到任何回帧 → 判定链路已死，立刻重连
			if (st.hbPendingSince && Date.now() - st.hbPendingSince > PROBE_TIMEOUT_MS) {
				debug("probe timeout after " + (Date.now() - st.hbPendingSince) + "ms");
				dropConnection("探活超时");
				return;
			}
			var silentFor = Date.now() - st.lastRx;
			if (silentFor > SILENCE_TIMEOUT_MS) {
				debug("heartbeat timeout, silent " + silentFor + "ms");
				dropConnection("心跳超时");
				return;
			}
			st.hbPendingSince = Date.now();
			sendRaw({ type: "ping", id: "hb-" + Date.now(), timestamp: Date.now() });
		}, HEARTBEAT_MS);
	}

	function dropConnection(reason) {
		debug("drop connection: " + reason);
		st.connected = false;
		st.connecting = false;
		st.portWaiters = {};
		try { if (st.curWsId) eda.sys_WebSocket.close(st.curWsId); } catch (e) { /* ignore */ }
		stopHeartbeat();
		if (!st.stopped) scheduleRetry();
	}

	function scheduleRetry() {
		if (st.retryTimer || st.stopped) return;
		var delay = Math.min(RETRY_BASE_MS * Math.pow(2, Math.min(st.retry, 5)), RETRY_MAX_MS);
		st.retry += 1;
		st.retryTimer = setTimeout(function () {
			st.retryTimer = null;
			connectAll();
		}, delay);
	}

	function tryPort(port, gen) {
		return new Promise(function (resolve) {
			var wsId = nextWsId();
			st.curWsId = wsId;
			var settled = false;
			var timer = setTimeout(function () {
				if (settled) return;
				settled = true;
				delete st.portWaiters[wsId];
				try { eda.sys_WebSocket.close(wsId); } catch (e) { /* ignore */ }
				resolve(false);
			}, CONNECT_TIMEOUT_MS);

			// 只有收到合法 hello 才算这条端口可用（防连到同端口上别的服务）
			st.portWaiters[wsId] = function () {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			};

			try {
				eda.sys_WebSocket.register(
					wsId,
					"ws://127.0.0.1:" + port + WS_PATH,
					function (event) {
						if (gen !== st.gen) return;
						handleIncoming(event);
					},
					function () {
						// 已建连：不急着 register，先等服务端 hello 认身份
					}
				);
			} catch (e) {
				debug("register failed on port " + port + ": " + msg(e));
				delete st.portWaiters[wsId];
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(false);
				}
			}
		});
	}

	async function connectAll() {
		if (st.connecting || st.stopped) return;
		st.gen += 1;
		var gen = st.gen;
		st.connecting = true;
		st.retryTimer = null;
		var ports = portCandidates();
		for (var i = 0; i < ports.length; i++) {
			if (gen !== st.gen || st.stopped) break;
			var port = ports[i];
			var ok = await tryPort(port, gen);
			if (ok) {
				st.port = port;
				st.connecting = false;
				st.connected = true;
				st.lastRx = Date.now();
				st.retry = 0;
				debug("tcp connected on port " + port);
				sendRaw(registerPayload());
				startHeartbeat();
				toast("FuliForge 已连接（端口 " + port + "）");
				return;
			}
		}
		st.connecting = false;
		if (gen === st.gen) scheduleRetry();
	}

	function handleIncoming(event) {
		st.lastRx = Date.now();
		st.hbPendingSince = 0;
		st.rxCount += 1;
		var text = "";
		try {
			text = typeof event.data === "string" ? event.data : String(event.data);
		} catch (e) {
			return;
		}
		var m;
		try { m = JSON.parse(text); } catch (e) { return; }
		if (!m || !m.type) return;

		if (m.type === "hello") {
			if (m.service && m.service !== SERVICE) {
				debug("service mismatch: " + m.service);
				return;
			}
			// server 标记不符＝这个端口上是别的程序，直接放弃，换下一个端口
			if (m.server !== HUB_MARK) {
				debug("跳过非本家服务（server=" + m.server + "）");
				return;
			}
			if (st.connected) return;
			var waiter = st.portWaiters[st.curWsId];
			if (waiter) {
				delete st.portWaiters[st.curWsId];
				waiter();
			}
			return;
		}
		if (m.type === "ping") {
			sendRaw({ type: "pong", id: m.id, timestamp: Date.now() });
			return;
		}
		if (m.type === "pong") return;
		if (m.type === "rpc") {
			handleRpc(m);
			return;
		}
	}

	async function handleRpc(m) {
		var id = m.id;
		var method = String(m.method || "");
		var params = m.params || {};
		var handler = HANDLERS[method];
		if (!handler) {
			replyError(id, "未知方法: " + method, { available: Object.keys(HANDLERS) });
			return;
		}
		try {
			var result = await handler(params);
			reply(id, result === undefined ? { ok: true } : result);
		} catch (e) {
			replyError(id, e);
		}
	}

	// ─────────────────────────── 文档上下文 ───────────────────────────
	function currentDocumentTitle() {
		try {
			if (eda.dmt_Schematic && eda.dmt_Schematic.getCurrentSchematicPageInfo) {
				var page = eda.dmt_Schematic.getCurrentSchematicPageInfo();
				if (page && page.name) return String(page.name);
			}
		} catch (e) { /* ignore */ }
		try {
			if (eda.dmt_Pcb && eda.dmt_Pcb.getCurrentPcbInfo) {
				var pcb = eda.dmt_Pcb.getCurrentPcbInfo();
				if (pcb && pcb.name) return String(pcb.name);
			}
		} catch (e) { /* ignore */ }
		return "";
	}

	async function projectInfo() {
		var out = { apis: {} };
		if (hasApi("eda.dmt_Project.getCurrentProjectInfo")) {
			out.apis.project = "ok";
			try {
				out.project = plain(await eda.dmt_Project.getCurrentProjectInfo(), 4);
			} catch (e) { out.apis.project = "error: " + msg(e); }
		} else {
			out.apis.project = "missing";
		}
		var jobs = [
			["dmt_Schematic", "getAllSchematicsInfo", "schematics"],
			["dmt_Schematic", "getAllSchematicPagesInfo", "schematicPages"],
			["dmt_Pcb", "getAllPcbsInfo", "pcbs"],
			["dmt_Board", "getAllBoardsInfo", "boards"],
			["dmt_Panel", "getAllPanelsInfo", "panels"]
		];
		for (var i = 0; i < jobs.length; i++) {
			var ns = jobs[i][0], fn = jobs[i][1], key = jobs[i][2];
			var path = "eda." + ns + "." + fn;
			if (!hasApi(path)) { out.apis[ns + "." + fn] = "missing"; continue; }
			try {
				out[key] = plain(await eda[ns][fn](), 4);
				out.apis[ns + "." + fn] = "ok";
			} catch (e) {
				out.apis[ns + "." + fn] = "error: " + msg(e);
				if (key === "pcbs" || key === "schematicPages") {
					out[key] = [];
				}
			}
		}
		return out;
	}

	// ─────────────────────────── 器件库 ───────────────────────────
	function normalizeSearchItem(raw) {
		var o = raw || {};
		var props = o.otherProperty || o.properties || {};
		return {
			uuid: o.uuid || "",
			libraryUuid: o.libraryUuid || "",
			name: o.name || "",
			symbolName: o.symbolName || "",
			footprintName: o.footprintName || "",
			manufacturer: o.manufacturer || "",
			manufacturerId: o.manufacturerId || "",
			supplier: o.supplier || "",
			supplierId: o.supplierId || "",
			description: o.description || "",
			properties: plain(props, 3)
		};
	}

	async function libSearch(p) {
		if (!hasApi("eda.lib_Device.search")) {
			throw new Error("当前 EDA 版本没有 lib_Device.search（需要 EDA Pro 3.2+）");
		}
		var limit = Math.max(1, Math.min(50, Number(p.limit) || 10));
		var query = String(p.query || "");
		if (!query) throw new Error("query 不能为空");
		var res = await eda.lib_Device.search(
			query,
			p.libraryUuid || undefined,
			p.classification || undefined,
			p.symbolType || undefined,
			limit,
			Number(p.page) || 1
		);
		var arr = [];
		if (Array.isArray(res)) arr = res;
		else if (res && Array.isArray(res.items)) arr = res.items;
		else if (res && Array.isArray(res.list)) arr = res.list;
		return {
			query: query,
			count: arr.length,
			items: arr.slice(0, limit).map(normalizeSearchItem)
		};
	}

	function assocOf(dev) {
		var a = (dev && dev.association) || {};
		var sym = a.symbol || a.Symbol || null;
		var fp = a.footprint || a.Footprint || null;
		return { symbol: sym, footprint: fp };
	}

	async function libDevice(p) {
		if (!hasApi("eda.lib_Device.get")) throw new Error("缺少 lib_Device.get");
		var uuid = String(p.deviceUuid || p.uuid || "");
		if (!uuid) throw new Error("deviceUuid 必填");
		var dev = await eda.lib_Device.get(uuid, p.libraryUuid || undefined);
		if (!dev) throw new Error("器件不存在: " + uuid);
		var assoc = assocOf(dev);
		var out = {
			device: {
				uuid: dev.uuid || uuid,
				libraryUuid: dev.libraryUuid || p.libraryUuid || "",
				name: dev.name || "",
				description: dev.description || "",
				property: plain(dev.property, 4),
				subPartNames: plain(dev.subPartNames, 3),
				classification: plain(dev.classification, 3)
			},
			symbol: null,
			footprint: null,
			model3D: null,
			apis: {}
		};

		var prop = dev.property || {};
		var other = prop.otherProperty || {};
		var modelUuid = other["3D Model"] || other["3D Model UUID"] || "";
		var modelTransform = other["3D Model Transform"] || other["3D Model Transform UUID"] || "";
		out.model3D = {
			uuid: modelUuid || "",
			transform: modelTransform || "",
			title: other["3D Model Title"] || ""
		};

		if (assoc.symbol) {
			out.apis.symbol = "ok";
			var srcText = null;
			if (!p.skipSources && hasApi("eda.lib_Symbol.getDocumentSource")) {
				try {
					srcText = await eda.lib_Symbol.getDocumentSource(assoc.symbol.uuid, assoc.symbol.libraryUuid);
				} catch (e) { out.apis.symbol = "source-error: " + msg(e); }
			}
			var meta = null;
			if (hasApi("eda.lib_Symbol.get")) {
				try { meta = await eda.lib_Symbol.get(assoc.symbol.uuid, assoc.symbol.libraryUuid); }
				catch (e) { /* 元信息失败不致命 */ }
			}
			var geo = null;
			if (!p.skipSources && hasApi("eda.lib_Symbol.getGeometry")) {
				try { geo = await eda.lib_Symbol.getGeometry(assoc.symbol.uuid, assoc.symbol.libraryUuid); }
				catch (e) { /* 同上 */ }
			}
			out.symbol = {
				uuid: assoc.symbol.uuid,
				libraryUuid: assoc.symbol.libraryUuid || "",
				type: assoc.symbol.type,
				name: (meta && meta.name) || "",
				description: (meta && meta.description) || "",
				sourceBytes: typeof srcText === "string" ? srcText.length : 0,
				source: typeof srcText === "string" ? srcText : "",
				geometry: plain(geo, 4)
			};
		}

		if (assoc.footprint) {
			out.apis.footprint = "ok";
			var fpSrc = null;
			if (!p.skipSources && hasApi("eda.lib_Footprint.getDocumentSource")) {
				try {
					fpSrc = await eda.lib_Footprint.getDocumentSource(assoc.footprint.uuid, assoc.footprint.libraryUuid);
				} catch (e) { out.apis.footprint = "source-error: " + msg(e); }
			}
			var fpMeta = null;
			if (hasApi("eda.lib_Footprint.get")) {
				try { fpMeta = await eda.lib_Footprint.get(assoc.footprint.uuid, assoc.footprint.libraryUuid); }
				catch (e) { /* ignore */ }
			}
			var fpGeo = null;
			if (!p.skipSources && hasApi("eda.lib_Footprint.getGeometry")) {
				try { fpGeo = await eda.lib_Footprint.getGeometry(assoc.footprint.uuid, assoc.footprint.libraryUuid); }
				catch (e) { /* ignore */ }
			}
			out.footprint = {
				uuid: assoc.footprint.uuid,
				libraryUuid: assoc.footprint.libraryUuid || "",
				name: (fpMeta && fpMeta.name) || "",
				sourceBytes: typeof fpSrc === "string" ? fpSrc.length : 0,
				source: typeof fpSrc === "string" ? fpSrc : "",
				geometry: plain(fpGeo, 4),
				model3D: fpMeta && fpMeta.model3D ? plain(fpMeta.model3D, 3) : null
			};
		}

		if (p.includeSource === false) {
			if (out.symbol) delete out.symbol.source;
			if (out.footprint) delete out.footprint.source;
		}
		return out;
	}

	async function libSource(p) {
		var kind = String(p.kind || "symbol");
		var uuid = String(p.uuid || "");
		if (!uuid) throw new Error("uuid 必填");
		var ns = kind === "footprint" ? "lib_Footprint" : "lib_Symbol";
		var path = "eda." + ns + ".getDocumentSource";
		if (!hasApi(path)) throw new Error("缺少 " + ns + ".getDocumentSource");
		var text = await eda[ns].getDocumentSource(uuid, p.libraryUuid || undefined);
		if (typeof text !== "string" || !text.length) {
			throw new Error(ns + ".getDocumentSource 未返回文本（可能是工程库内器件，需要 libraryUuid='project'）");
		}
		return { kind: kind, uuid: uuid, bytes: text.length, source: text };
	}

	async function writeText(targetDir, fileName, text) {
		var uri = joinPath(targetDir, fileName);
		var written = false;
		var error = "";
		if (!hasApi("eda.sys_FileSystem.saveFileToFileSystem")) {
			throw new Error("缺少 sys_FileSystem.saveFileToFileSystem（需要客户端版 EDA 且允许外部交互）");
		}
		var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
		try {
			written = await eda.sys_FileSystem.saveFileToFileSystem(uri, blob, fileName);
		} catch (e) { error = msg(e); }
		if (!written) {
			try {
				if (hasApi("eda.sys_FileSystem.deleteFileInFileSystem")) {
					await eda.sys_FileSystem.deleteFileInFileSystem(uri, true);
				}
			} catch (e) { /* 目标不存在时删除会失败，忽略 */ }
			try {
				written = await eda.sys_FileSystem.saveFileToFileSystem(uri, blob, fileName);
				if (written) error = "";
			} catch (e) { error = msg(e); }
		}
		return { path: uri, written: written === true, error: error };
	}

	async function libDump(p) {
		var dir = String(p.targetDir || (await defaultTargetDir()));
		if (!dir) throw new Error("targetDir 为空");
		rememberTarget(dir);
		var items = Array.isArray(p.items) ? p.items : [];
		if (!items.length) throw new Error("items 为空");
		var results = [];
		for (var i = 0; i < items.length; i++) {
			var it = items[i] || {};
			var kind = String(it.kind || "symbol");
			try {
				var src = await libSource({ kind: kind, uuid: it.uuid, libraryUuid: it.libraryUuid });
				var base = safeName(it.name || (kind + "_" + String(it.uuid).slice(0, 8)));
				var ext = kind === "footprint" ? ".fp.log" : ".sym.log";
				var suffix = "_" + String(it.uuid || "").slice(0, 8);
				var file = base + suffix + ext;
				var w = await writeText(dir, file, src.source);
				results.push({
					ok: w.written,
					kind: kind,
					uuid: it.uuid,
					designator: it.designator || "",
					file: file,
					path: w.path,
					bytes: src.bytes,
					error: w.error
				});
			} catch (e) {
				results.push({ ok: false, kind: kind, uuid: it.uuid, error: msg(e) });
			}
		}
		var okCount = results.filter(function (r) { return r.ok; }).length;
		return { targetDir: dir, total: results.length, ok: okCount, failed: results.length - okCount, results: results };
	}

	// ─────────────────────────── 3D 模型 ───────────────────────────
	async function model3D(p) {
		var uuid = String(p.modelUuid || p.uuid || "");
		var out = { uuid: uuid, meta: null, files: [], dependencies: {} };
		if (!uuid) throw new Error("modelUuid 必填");
		if (hasApi("eda.lib_3DModel.get")) {
			out.dependencies["lib_3DModel.get"] = "ok";
			try { out.meta = plain(await eda.lib_3DModel.get(uuid, p.libraryUuid || undefined), 4); }
			catch (e) { out.dependencies["lib_3DModel.get"] = "error: " + msg(e); }
		} else {
			out.dependencies["lib_3DModel.get"] = "missing";
		}
		// 本地库目录扫描：把与 uuid 同名的 step/obj 找出来（EDA 客户端把模型缓存在库目录）
		try {
			if (hasApi("eda.sys_FileSystem.getLibrariesPaths")) {
				var roots = await eda.sys_FileSystem.getLibrariesPaths();
				out.dependencies["getLibrariesPaths"] = "ok";
				var rootList = Array.isArray(roots) ? roots : (roots ? [roots] : []);
				out.libraryRoots = plain(rootList, 2);
				if (rootList.length && hasApi("eda.sys_FileSystem.listFilesOfFileSystem")) {
					for (var r = 0; r < rootList.length && r < 3; r++) {
						try {
							var listing = await eda.sys_FileSystem.listFilesOfFileSystem(rootList[r], true);
							var files = Array.isArray(listing) ? listing : [];
							var hits = files.filter(function (f) {
								var s = String(f && (f.uri || f.path || f) || "");
								if (s.indexOf(uuid) < 0) return false;
								return /\.(step|stp|obj|wrl)$/i.test(s);
							});
							out.files = out.files.concat(plain(hits.slice(0, 10), 2));
						} catch (e) {
							out.dependencies["listFilesOfFileSystem"] = "error: " + msg(e);
						}
					}
				}
			} else {
				out.dependencies["getLibrariesPaths"] = "missing";
			}
		} catch (e) {
			out.dependencies["scan"] = "error: " + msg(e);
		}
		if (!out.files.length) {
			out.hint = "EDA 插件 API 未暴露 3D 模型文件本体。可改用：① 嘉立创器件页下载 STEP/OBJ；② 本地库目录按 uuid 搜索；③ 用封装尺寸在 FreeCAD/Blender 重建。";
		}
		return out;
	}

	// ─────────────────────────── 设计规则 ───────────────────────────
	async function grabInto(bucket, ns, method, key, args) {
		var path = "eda." + ns + "." + method;
		if (!hasApi(path)) {
			bucket.apis[path] = "missing";
			return;
		}
		try {
			bucket[key] = plain(await eda[ns][method].apply(eda[ns], args || []), 8);
			bucket.apis[path] = "ok";
		} catch (e) {
			bucket.apis[path] = "error: " + msg(e);
		}
	}

	async function collectRules() {
		var out = { generatedAt: new Date().toISOString(), extensionVersion: EXT_VERSION, apis: {} };
		await grabInto(out, "pcb_Drc", "getCurrentRuleConfigurationName", "currentRuleConfigurationName");
		await grabInto(out, "pcb_Drc", "getDefaultRuleConfigurationName", "defaultRuleConfigurationName");
		await grabInto(out, "pcb_Drc", "getAllRuleConfigurations", "ruleConfigurations", [true]);
		await grabInto(out, "pcb_Drc", "getAllNetClasses", "netClasses");
		await grabInto(out, "pcb_Drc", "getAllDifferentialPairs", "differentialPairs");
		await grabInto(out, "pcb_Drc", "getAllEqualLengthNetGroups", "equalLengthNetGroups");
		await grabInto(out, "pcb_Drc", "getAllPadPairGroups", "padPairGroups");
		await grabInto(out, "pcb_Drc", "getNetRules", "netRules");
		await grabInto(out, "pcb_Drc", "getNetByNetRules", "netByNetRules");
		await grabInto(out, "pcb_Drc", "getRegionRules", "regionRules");

		var cfgName = out.currentRuleConfigurationName;
		if (typeof cfgName === "string" && cfgName && hasApi("eda.pcb_Drc.getRuleConfiguration")) {
			await grabInto(out, "pcb_Drc", "getRuleConfiguration", "currentRuleConfiguration", [cfgName]);
		}
		if (typeof cfgName === "string" && cfgName && hasApi("eda.pcb_Drc.getPadPairGroupMinWireLength")) {
			// 可选信息：拿不到就跳过
			await grabInto(out, "pcb_Drc", "getRealTimeDrcStatus", "realTimeDrcStatus");
		}

		var layers = { apis: {} };
		await grabInto(layers, "pcb_Layer", "getAllLayers", "layers");
		await grabInto(layers, "pcb_Layer", "getStackup", "stackup");
		await grabInto(layers, "pcb_Layer", "getCurrentPhysicalStackingConfiguration", "currentPhysicalStacking");
		await grabInto(layers, "pcb_Layer", "getCurrentPhysicalStackingConfigurationName", "currentPhysicalStackingName");
		await grabInto(layers, "pcb_Layer", "getDefaultPhysicalStackingConfigurationName", "defaultPhysicalStackingName");

		out.layers = layers;
		return out;
	}

	async function rulesDump(p) {
		var dir = String(p.targetDir || (await defaultTargetDir()));
		rememberTarget(dir);
		var data = await collectRules();
		var written = {};
		written.rules = await writeText(dir, "easyeda_rules.json", JSON.stringify(data, null, 1));
		var layersOnly = {
			generatedAt: data.generatedAt,
			apis: data.layers ? data.layers.apis : {},
			layers: data.layers ? data.layers.layers : null,
			stackup: data.layers ? data.layers.stackup : null,
			currentPhysicalStacking: data.layers ? data.layers.currentPhysicalStacking : null
		};
		written.layers = await writeText(dir, "easyeda_layers.json", JSON.stringify(layersOnly, null, 1));
		var meta = {
			generatedAt: data.generatedAt,
			extensionVersion: EXT_VERSION,
			windowId: st.windowId,
			port: st.port,
			apis: data.apis,
			documentTitle: currentDocumentTitle()
		};
		written.meta = await writeText(dir, "easyeda_rules_meta.json", JSON.stringify(meta, null, 1));
		return {
			targetDir: dir,
			files: written,
			ruleApis: data.apis,
			layerApis: data.layers ? data.layers.apis : {}
		};
	}

	async function pcbDrc(p) {
		var out = { apis: {} };
		if (hasApi("eda.pcb_Drc.checkDetailed")) {
			try {
				out.detailed = plain(await eda.pcb_Drc.checkDetailed({}), 6);
				out.apis.checkDetailed = "ok";
			} catch (e) { out.apis.checkDetailed = "error: " + msg(e); }
		} else {
			out.apis.checkDetailed = "missing";
		}
		if (!out.detailed && hasApi("eda.pcb_Drc.check")) {
			try {
				out.result = plain(await eda.pcb_Drc.check(p.strict !== false, false, true), 6);
				out.apis.check = "ok";
			} catch (e) { out.apis.check = "error: " + msg(e); }
		} else if (!out.detailed) {
			out.apis.check = "missing";
		}
		if (hasApi("eda.pcb_Drc.getDrcResult")) {
			try {
				out.lastResult = plain(await eda.pcb_Drc.getDrcResult(), 6);
				out.apis.getDrcResult = "ok";
			} catch (e) { out.apis.getDrcResult = "error: " + msg(e); }
		}
		return out;
	}

	// ─────────────────────────── 当前页面器件收集 ───────────────────────────
	async function collectSchematicDevices(pageUuid) {
		var items = [];
		var seen = {};
		if (!hasApi("eda.sch_PrimitiveComponent.getAllPrimitiveId")) {
			throw new Error("缺少 sch_PrimitiveComponent.getAllPrimitiveId");
		}
		var ids;
		try {
			ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId();
		} catch (e) {
			throw new Error("读取当前原理图图元失败（" + msg(e) +
				"）。这条 API 只对活动文档有效：如果你现在停在 PCB 页面，请先点开原理图页（Schematic1 → P1）再试");
		}
		if (!ids || !ids.length) return items;
		var comps = await eda.sch_PrimitiveComponent.get(ids);
		var list = Array.isArray(comps) ? comps : [comps];
		// 批量 get() 返回的对象不一定带完整状态：把每个图元的 getState_* 全部调一遍，
		// 原样回传，服务端才能看出到底哪个字段是位号、哪个是器件名。
		var sts = ["PrimitiveId", "PrimitiveType", "ComponentType", "Designator", "Name",
			"X", "Y", "Rotation", "Mirror", "AddIntoBom", "AddIntoPcb",
			"Manufacturer", "ManufacturerId", "Supplier", "SupplierId",
			"UniqueId", "SubPartName", "Net"];
		var objKeys = ["Component", "Symbol", "Footprint", "OtherProperty"];
		for (var i = 0; i < list.length && i < 500; i++) {
			var c = list[i];
			if (!c) continue;
			var raw = { _i: i };
			for (var si = 0; si < sts.length; si++) {
				var fn = "getState_" + sts[si];
				if (typeof c[fn] === "function") {
					try { raw[sts[si]] = c[fn](); } catch (e1) { raw[sts[si]] = "ERR:" + msg(e1); }
				}
			}
			for (var oj = 0; oj < objKeys.length; oj++) {
				var fk = "getState_" + objKeys[oj];
				if (typeof c[fk] === "function") {
					try { raw[objKeys[oj]] = c[fk](); } catch (e2) { raw[objKeys[oj]] = "ERR:" + msg(e2); }
				}
			}
			var ref = (raw.Component && raw.Component.uuid) ? raw.Component : null;
			var des = (raw.Designator !== undefined && raw.Designator !== null) ? String(raw.Designator) : "";
			var nm = (raw.Name !== undefined && raw.Name !== null) ? String(raw.Name) : "";
			items.push({
				deviceUuid: ref ? ref.uuid : "",
				libraryUuid: ref ? ref.libraryUuid : "",
				deviceName: (ref && ref.name) || nm || "",
				designators: des ? [des] : [],
				raw: raw
			});
		}
		return items;
	}

	async function expandDevices(devices, limit) {
		var out = [];
		var max = Math.min(devices.length, limit || 60);
		for (var i = 0; i < max; i++) {
			var d = devices[i];
			try {
				var detail = await libDevice({ deviceUuid: d.deviceUuid, libraryUuid: d.libraryUuid, skipSources: true });
				var assoc = { symbol: null, footprint: null };
				if (detail.symbol) assoc.symbol = detail.symbol;
				if (detail.footprint) assoc.footprint = detail.footprint;
				out.push({
					deviceUuid: d.deviceUuid,
					libraryUuid: d.libraryUuid,
					deviceName: detail.device && detail.device.name ? detail.device.name : d.deviceName,
					designators: d.designators || [],
					lcsc: (detail.device && detail.device.property && detail.device.property.supplierId) || "",
					symbol: assoc.symbol ? { uuid: assoc.symbol.uuid, libraryUuid: assoc.symbol.libraryUuid, name: assoc.symbol.name } : null,
					footprint: assoc.footprint ? { uuid: assoc.footprint.uuid, libraryUuid: assoc.footprint.libraryUuid, name: assoc.footprint.name } : null,
					model3D: detail.model3D,
					error: ""
				});
			} catch (e) {
				out.push({ deviceUuid: d.deviceUuid, libraryUuid: d.libraryUuid, error: msg(e) });
			}
		}
		return out;
	}

	// ─────────────────────────── RPC 表 ───────────────────────────
	var HANDLERS = {
		"ping": function () {
			return { ok: true, ts: Date.now(), extensionVersion: EXT_VERSION };
		},
		"status": function () {
			return {
				connected: st.connected,
				port: st.port,
				windowId: st.windowId,
				rx: st.rxCount,
				tx: st.txCount,
				silentMs: Date.now() - st.lastRx,
				extensionVersion: EXT_VERSION,
				documentTitle: currentDocumentTitle()
			};
		},
		"probe": async function () {
			var out = { namespaces: [], methods: {}, apis: {} };
			try { out.namespaces = Object.keys(eda).sort(); } catch (e) { out.namespaces = []; }
			var interesting = [
				"lib_Device", "lib_Symbol", "lib_Footprint", "lib_3DModel", "lib_LibrariesList",
				"lib_Classification", "lib_SimulationModel",
				"pcb_Drc", "pcb_Layer", "pcb_Document", "pcb_PrimitiveComponent", "pcb_PrimitivePad",
				"pcb_PrimitiveVia", "pcb_PrimitivePour", "pcb_ManufactureData",
				"sch_Drc", "sch_Document", "sch_PrimitiveComponent", "sch_PrimitiveWire",
				"sch_Netlist", "sch_ManufactureData",
				"dmt_Project", "dmt_Schematic", "dmt_Pcb", "dmt_Board", "dmt_Panel", "dmt_EditorControl",
				"sys_WebSocket", "sys_FileSystem", "sys_Storage", "sys_Dialog", "sys_Message", "sys_MessageBus"
			];
			for (var i = 0; i < interesting.length; i++) {
				var ns = interesting[i];
				var obj = null;
				try { obj = eda[ns]; } catch (e) { obj = null; }
				if (!obj) { out.apis[ns] = "missing"; continue; }
				out.apis[ns] = "ok";
				out.methods[ns] = methodNames(obj);
			}
			out.capabilities = Object.keys(HANDLERS);
			return out;
		},
		"project.info": projectInfo,
		"lib.search": libSearch,
		"lib.device": libDevice,
		"lib.source": libSource,
		"lib.dump": libDump,
		"model.3d": model3D,
		"rules.dump": rulesDump,
		"rules.collect": collectRules,
		"pcb.drc": pcbDrc,
		"pcb.stackup": async function () {
			var out = { apis: {} };
			await grabInto(out, "pcb_Layer", "getStackup", "stackup");
			await grabInto(out, "pcb_Layer", "getCurrentPhysicalStackingConfiguration", "configuration");
			await grabInto(out, "pcb_Layer", "getAllLayers", "layers");
			return out;
		},
		"schematic.devices": async function (p) {
			var list = await collectSchematicDevices(p.pageUuid);
			var expanded = await expandDevices(list, Number(p.limit) || 60);
			return { count: list.length, unique: expanded.length, devices: expanded };
		},
		"schematic.export": async function (p) {
			return exportCurrentSilently(p && p.targetDir);
		},
		"schematic.netlist": async function (p) {
			if (!hasApi("eda.sch_Netlist.getNetlist")) throw new Error("缺少 sch_Netlist.getNetlist");
			var type = p.type === undefined ? 0 : p.type;
			var net = await eda.sch_Netlist.getNetlist(type);
			if (p.saveTo) {
				var w = await writeText(String(p.saveTo), String(p.fileName || "easyeda_netlist.txt"), typeof net === "string" ? net : JSON.stringify(net, null, 1));
				return { bytes: typeof net === "string" ? net.length : 0, written: w };
			}
			return { type: type, netlist: typeof net === "string" ? net : plain(net, 6) };
		},
		"doc.save": async function () {
			var out = { apis: {} };
			await grabInto(out, "sch_Document", "save", "schematicSaved");
			await grabInto(out, "pcb_Document", "save", "pcbSaved");
			return out;
		}
	};

	// ─────────────────────────── 菜单动作 ───────────────────────────
	async function exportCurrentSilently(targetDir) {
		var dir = String(targetDir || (await defaultTargetDir()));
		rememberTarget(dir);
		var devices = await collectSchematicDevices();
		if (!devices.length) throw new Error("当前原理图页没有可用器件（需要打开原理图页面）");
		var expanded = await expandDevices(devices, 80);
		var items = [];
		expanded.forEach(function (d) {
			if (d.symbol && d.symbol.uuid) {
				items.push({ kind: "symbol", uuid: d.symbol.uuid, libraryUuid: d.symbol.libraryUuid, name: d.symbol.name || d.deviceName });
			}
			if (d.footprint && d.footprint.uuid) {
				items.push({ kind: "footprint", uuid: d.footprint.uuid, libraryUuid: d.footprint.libraryUuid, name: d.footprint.name || d.deviceName });
			}
		});
		var manifest = {
			generatedAt: new Date().toISOString(),
			extensionVersion: EXT_VERSION,
			documentTitle: currentDocumentTitle(),
			devices: expanded.map(function (d) {
				return {
					designators: d.designators,
					deviceUuid: d.deviceUuid,
					libraryUuid: d.libraryUuid,
					name: d.deviceName,
					lcsc: d.lcsc,
					symbolUuid: d.symbol ? d.symbol.uuid : "",
					symbolLibraryUuid: d.symbol ? d.symbol.libraryUuid : "",
					footprintUuid: d.footprint ? d.footprint.uuid : "",
					footprintLibraryUuid: d.footprint ? d.footprint.libraryUuid : "",
					model3D: d.model3D || null,
					error: d.error || ""
				};
			})
		};
		var dumped = await libDump({ targetDir: dir, items: items });
		await writeText(dir, "easyeda_devices.json", JSON.stringify(manifest, null, 1));
		return { targetDir: dir, devices: expanded.length, items: items.length, dumped: dumped };
	}

	function activate(status, arg) {
		st.windowId = "";
		try {
			st.windowId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() :
				"w-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
		} catch (e) {
			st.windowId = "w-" + Date.now();
		}
		st.preferredPort = readPreferredPort();
		var auto = true;
		try {
			var stored = eda.sys_Storage.getExtensionUserConfig(STORE_AUTOCONNECT);
			auto = stored !== false;
		} catch (e) { auto = true; }
		st.stopped = !auto;
		debug("activate, windowId=" + st.windowId + " auto=" + auto);
		if (auto) connectAll();
	}

	function deactivate() {
		st.stopped = true;
		st.gen += 1;
		stopHeartbeat();
		if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
		try { if (st.curWsId) eda.sys_WebSocket.close(st.curWsId); } catch (e) { /* ignore */ }
		st.connected = false;
	}

	function sleep(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	async function showStatus() {
		var probeNote = "";
		if (st.connected) {
			var before = st.rxCount;
			sendRaw({ type: "ping", id: "ui-" + Date.now(), timestamp: Date.now() });
			await sleep(600);
			probeNote = st.rxCount > before ? " · 探活已回应" : " · 探活无回应（链路可能已断，正在重连）";
		}
		var dir = "";
		try { dir = await defaultTargetDir(); } catch (e) { dir = "(读取失败)"; }
		var lines = [
			"FuliForge Bridge v" + EXT_VERSION,
			"连接: " + (st.connected ? "已连接 (端口 " + st.port + ")" + probeNote : (st.stopped ? "手动停止" : "未连接")),
			"窗口: " + (st.windowId || "(未初始化)"),
			"收发: " + st.txCount + " / " + st.rxCount,
			"最近收帧: " + (st.lastRx ? Math.round((Date.now() - st.lastRx) / 1000) + " 秒前" : "还没收到过"),
			"外部交互: " + (hasApi("eda.sys_WebSocket.register") ? "可用" : "不可用（需在扩展管理器勾选『允许外部交互』）"),
			"默认导出目录: " + dir
		];
		info(lines.join("\n"));
	}

	function reconnect() {
		st.stopped = false;
		st.gen += 1;
		st.retry = 0;
		try { if (st.curWsId) eda.sys_WebSocket.close(st.curWsId); } catch (e) { /* ignore */ }
		st.connected = false;
		connectAll();
		toast("FuliForge 正在重连…");
	}

	async function exportCurrent() {
		try {
			toast("正在收集当前页器件…");
			var r = await exportCurrentSilently();
			info("已导出 " + r.devices + " 个器件（" + r.items + " 个库文件）\n目录: " + r.targetDir +
				"\n成功 " + r.dumped.ok + " / 失败 " + r.dumped.failed);
		} catch (e) {
			info("导出失败: " + msg(e));
		}
	}

	async function exportRules() {
		try {
			var r = await rulesDump({});
			info("设计规则已导出到:\n" + r.targetDir +
				"\n规则 API:\n" + JSON.stringify(r.ruleApis, null, 1) +
				"\n图层 API:\n" + JSON.stringify(r.layerApis, null, 1));
		} catch (e) {
			info("导出规则失败: " + msg(e));
		}
	}

	function about() {
		info([
			"FuliForge Bridge v" + EXT_VERSION,
			"",
			"作用: 把嘉立创 EDA 的器件 / 符号 / 封装 / 3D 模型引用 / 设计规则",
			"导出到本地 FuliForge 平台，再转换成 KiCad / Altium 可用的库。",
			"",
			"通道: ws://127.0.0.1:" + PORT_START + "-" + PORT_END + WS_PATH,
			"协议: " + SERVICE + " / v" + PROTOCOL_VERSION,
			"",
			"注意: 必须在「扩展管理器 -> 允许外部交互」开启后本插件才能联网。",
			"", "本插件输出均为待审草稿，需人工复核后再进产线。"
		].join("\n"));
	}

	return {
		activate: activate,
		deactivate: deactivate,
		showStatus: showStatus,
		reconnect: reconnect,
		exportCurrent: exportCurrent,
		exportRules: exportRules,
		about: about
	};
})();
