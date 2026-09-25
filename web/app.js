/* 微信聊天分析站 · 前端逻辑（双模式：本机后端 / 纯网页） */
"use strict";

// ---------------- 状态 ----------------
const state = {
  localMode: null,          // null=未探测, true=有本机后端, false=纯网页
  status: null,
  accountSel: null,
  sessions: [], contacts: [], imports: [],
  filter: "personal", search: "",
  selected: null,
  relation: "romance",
  start: "", end: "",
  analysis: null,
  ai: null,
  view: "rule",
  qaLog: [],
  webMessages: null,        // 网页模式当前导入的消息
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `请求失败 (${res.status})`);
  }
  return data;
}

function show(name) {
  for (const s of ["home", "select", "result"]) {
    $("#screen-" + s).classList.toggle("hidden", s !== name);
  }
  window.scrollTo({ top: 0 });
}

// ---------------- 网页模式的导入存储（localStorage） ----------------
const LS_IMPORTS = "wxci_imports";
const LS_MSG_PREFIX = "wxci_import_msg_";

function webLoadImports() {
  try { return JSON.parse(localStorage.getItem(LS_IMPORTS) || "[]"); } catch (e) { return []; }
}
function webSaveImports(list) { localStorage.setItem(LS_IMPORTS, JSON.stringify(list)); }
function webSaveMessages(id, messages) {
  try {
    const json = JSON.stringify(messages);
    if (json.length < 1500000) localStorage.setItem(LS_MSG_PREFIX + id, json);
  } catch (e) { /* 太大就不持久化，仅内存 */ }
}
function webLoadMessages(id) {
  try { return JSON.parse(localStorage.getItem(LS_MSG_PREFIX + id) || "null"); } catch (e) { return null; }
}

// ---------------- 首页 ----------------
async function detectMode() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("/api/status", { signal: ctrl.signal });
    const data = await res.json();
    state.localMode = !!(res.ok && data && data.ok);
  } catch (e) {
    state.localMode = false;
  }
}

async function loadStatus() {
  try {
    state.status = await api("/api/status");
  } catch (e) {
    toast("无法连接本地服务：" + e.message);
    return;
  }
  const s = state.status;
  const w = $("#stWechat");
  if (s.wechat_running === null) { w.textContent = "未知"; w.className = "v mid"; }
  else if (s.wechat_running) { w.textContent = "✅ 已运行"; w.className = "v ok"; }
  else { w.textContent = "❌ 未运行（请先登录微信）"; w.className = "v bad"; }

  $("#stAccounts").textContent = s.accounts.length ? `找到 ${s.accounts.length} 个账号` : "未找到";
  $("#stAccounts").className = "v " + (s.accounts.length ? "ok" : "mid");
  const k = $("#stKeys");
  if (s.configured) { k.textContent = "✅ 已提取"; k.className = "v ok"; }
  else { k.textContent = "未提取"; k.className = "v mid"; }

  const list = $("#accountList");
  if (!s.accounts.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:13.5px">
      未检测到微信 4.x 数据目录。<br>· 请确认本机已安装并登录过微信 4.x<br>
      · 或使用「导入聊天记录」功能</div>`;
  } else {
    list.innerHTML = s.accounts.map((a, i) => `
      <div class="account ${i === 0 && !state.accountSel ? "sel" : ""} ${state.accountSel === a.db_dir ? "sel" : ""}"
           data-dir="${esc(a.db_dir)}">
        <span class="radio"></span>
        <span class="name">${esc(a.account)}${a.active ? " <span class='tag'>· 最近活跃</span>" : ""}</span>
        <span class="tag">${esc(a.db_dir)}</span>
      </div>`).join("");
    if (!state.accountSel && s.accounts.length) state.accountSel = s.accounts[0].db_dir;
    list.querySelectorAll(".account").forEach(el => {
      el.onclick = () => {
        state.accountSel = el.dataset.dir;
        list.querySelectorAll(".account").forEach(x => x.classList.toggle("sel", x === el));
      };
    });
  }

  $("#btnExtract").disabled = !s.accounts.length;
  updateGotoButton();
  $("#llmStateText").textContent = s.llm_configured ? "已配置" : "未配置";
  loadImports();
}

function updateGotoButton() {
  if (state.localMode) {
    $("#btnGotoSelect").disabled = !(state.status?.configured || state.imports.length > 0);
  } else {
    $("#btnGotoSelect").disabled = !state.imports.length;
  }
}

async function loadImports() {
  if (state.localMode) {
    try {
      const d = await api("/api/imports");
      state.imports = d.imports.map(im => ({ id: im.id, name: im.name, count: im.count, local: true }));
    } catch (e) { state.imports = []; }
  } else {
    state.imports = webLoadImports();
  }
  updateGotoButton();
  renderImportList();
}

function renderImportList() {
  const box = $("#importList");
  box.innerHTML = state.imports.length ? state.imports.map(im => `
    <div class="chat-item" data-import="${esc(im.id)}">
      <div class="avatar" style="background:var(--blue-deep)">📄</div>
      <div class="info"><div class="name">${esc(im.name)}</div>
        <div class="last">导入记录 · ${im.count} 条消息</div></div>
      <button class="btn primary small">分析</button>
    </div>`).join("") : "";
  box.querySelectorAll("[data-import]").forEach(el => {
    el.querySelector("button").onclick = () => {
      state.selected = { import_id: el.dataset.import, chat: el.querySelector(".name").textContent };
      show("select");
      $("#selectSub").textContent = `对象：${state.selected.chat}（导入记录）`;
    };
  });
}

function bindHome() {
  $("#btnExtract").onclick = async () => {
    if (!state.accountSel) return toast("请先选择一个账号");
    const btn = $("#btnExtract");
    btn.disabled = true;
    $("#extractStatus").innerHTML = '<span class="spinner" style="display:inline-block"></span> 正在扫描微信进程内存提取密钥（约 10 秒）…';
    try {
      const r = await api("/api/init", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ db_dir: state.accountSel, force: false }),
      });
      $("#extractStatus").textContent = `✅ 成功提取 ${r.count} 个数据库密钥`;
      toast("密钥提取成功！");
      await loadStatus();
    } catch (e) {
      $("#extractStatus").textContent = "❌ " + e.message;
    } finally {
      btn.disabled = !state.status?.accounts.length;
    }
  };

  $("#fileInput").onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    $("#fileInfo").textContent = `读取中：${file.name}（${(file.size / 1024).toFixed(1)} KB）…`;
    const content = await file.text();
    const name = file.name.replace(/\.[^.]+$/, "");
    try {
      if (state.localMode) {
        const r = await api("/api/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content }),
        });
        $("#fileInfo").textContent = `✅ 已导入 ${r.count} 条消息`;
      } else {
        const data = Importer.parseImport(content, name);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        state.imports = [{ id, name, count: data.messages.length }, ...state.imports];
        webSaveImports(state.imports);
        webSaveMessages(id, data.messages);
        renderImportList();
        updateGotoButton();
        $("#fileInfo").textContent = `✅ 已导入 ${data.messages.length} 条消息（仅保存在本浏览器）`;
      }
      toast("导入成功");
    } catch (e) {
      $("#fileInfo").textContent = "❌ " + e.message;
    }
    ev.target.value = "";
  };

  $("#btnGotoSelect").onclick = () => { state.selected = null; show("select"); enterSelect(); };
  $("#btnOpenSettings").onclick = openSettings;
}

// ---------------- 设置 ----------------
async function openSettings() {
  if (state.localMode) {
    try {
      const d = await api("/api/config");
      $("#llmBase").value = d.llm.base_url || "";
      $("#llmModel").value = d.llm.model || "";
      $("#llmKey").value = "";
    } catch (e) { /* ignore */ }
  } else {
    const c = Llm.getConfig();
    $("#llmBase").value = c.base_url || "";
    $("#llmModel").value = c.model || "";
    $("#llmKey").value = "";
  }
  $("#settingsModal").classList.remove("hidden");
}

function bindSettings() {
  $("#btnCloseSettings").onclick = () => $("#settingsModal").classList.add("hidden");
  $("#settingsModal").onclick = (e) => { if (e.target === $("#settingsModal")) $("#settingsModal").classList.add("hidden"); };
  $("#btnSaveLlm").onclick = async () => {
    const base = $("#llmBase").value.trim();
    const model = $("#llmModel").value.trim();
    if (!base || !model) return toast("请填写 API 地址和模型名");
    try {
      if (state.localMode) {
        const body = { base_url: base, model };
        if ($("#llmKey").value.trim()) body.api_key = $("#llmKey").value.trim();
        await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        const c = Llm.getConfig();
        c.base_url = base; c.model = model;
        if ($("#llmKey").value.trim()) c.api_key = $("#llmKey").value.trim();
        Llm.setConfig(c);
      }
      toast("设置已保存");
      $("#settingsModal").classList.add("hidden");
      if (state.localMode) loadStatus(); else $("#llmStateText").textContent = Llm.getConfig().api_key ? "已配置" : "未配置";
    } catch (e) { toast(e.message); }
  };
  $("#btnClearKey").onclick = async () => {
    if (state.localMode) {
      await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear_key: true }) });
    } else {
      Llm.clearKey();
      $("#llmStateText").textContent = "未配置";
    }
    toast("已清除 Key");
    $("#settingsModal").classList.add("hidden");
  };
}

// ---------------- 选人页 ----------------
async function enterSelect() {
  $("#searchInput").value = "";
  $("#chatList").innerHTML = '<div style="color:var(--muted);font-size:13.5px">加载中…</div>';
  if (state.localMode) {
    try {
      const [s, c] = await Promise.all([api("/api/sessions?limit=800"), api("/api/contacts?limit=6000")]);
      state.sessions = s.sessions || [];
      state.contacts = c.contacts || [];
    } catch (e) {
      state.sessions = [];
      try { state.contacts = (await api("/api/contacts?limit=6000")).contacts || []; } catch (e2) { /* ignore */ }
    }
    try { const d = await api("/api/imports"); state.imports = d.imports.map(im => ({ id: im.id, name: im.name, count: im.count, local: true })); } catch (e) { state.imports = []; }
  } else {
    state.sessions = [];
    state.contacts = [];
    state.imports = webLoadImports();
  }
  renderChatList();
}

const AV_COLORS = ["#E39D92", "#8FA8C9", "#8FB383", "#D9B25F", "#B98A9E", "#C97C6E", "#7C96BB", "#A8BCA2"];

function isPersonal(u) {
  if (!u) return false;
  return !(u.startsWith("gh_") || u.endsWith("@openim") || u.endsWith("@chatroom")
    || u.includes("sessionholder") || u === "filehelper" || u === "notifymessage");
}

function renderChatList() {
  const q = state.search.trim().toLowerCase();
  const map = new Map();
  const now = Date.now() / 1000;

  for (const c of state.contacts) {
    const u = c.username;
    const name = c.remark || c.nick || u;
    const kind = isPersonal(u) ? "personal" : (u.endsWith("@chatroom") ? "group" : "other");
    map.set(u, { username: u, chat: name, is_group: kind === "group", kind, ts: 0, last: "", time: "" });
  }
  for (const s of state.sessions) {
    const u = s.username;
    const kind = isPersonal(u) ? "personal" : (u.endsWith("@chatroom") ? "group" : "other");
    const prev = map.get(u);
    map.set(u, {
      username: u, chat: s.chat || prev?.chat || u, is_group: s.is_group,
      kind: s.is_group ? "group" : kind, ts: s.timestamp || 0,
      last: s.last_message || "", time: s.time || "",
    });
  }
  let items = [...map.values()];
  if (state.filter === "personal") items = items.filter(i => i.kind === "personal");
  else if (state.filter === "group") items = items.filter(i => i.kind === "group");
  if (q) items = items.filter(i => (i.chat + " " + i.username).toLowerCase().includes(q));
  items.sort((a, b) => b.ts - a.ts);
  if (items.length > 300) items = items.slice(0, 300);

  const box = $("#chatList");
  const importItems = (state.imports || []).filter(im => !q || im.name.toLowerCase().includes(q)).map(im => `
    <div class="chat-item" data-import="${esc(im.id)}" data-n="${esc(im.name)}">
      <div class="avatar" style="background:var(--blue-deep)">📄</div>
      <div class="info"><div class="name">${esc(im.name)}</div>
        <div class="last">导入记录 · ${im.count} 条消息</div></div>
      <div class="time">导入</div>
    </div>`).join("");
  if (!items.length && !importItems) {
    box.innerHTML = `<div style="color:var(--muted);font-size:13.5px">${state.localMode ? "没有匹配的聊天对象" : "还没有导入记录：请先回到首页导入聊天记录文件"}</div>`;
    return;
  }
  box.innerHTML = importItems + items.map((it, i) => {
    const day = it.ts ? `${Math.floor((now - it.ts) / 86400)}天前` : "";
    return `<div class="chat-item" data-u="${esc(it.username)}" data-n="${esc(it.chat)}" data-g="${it.is_group ? 1 : 0}">
      <div class="avatar" style="background:${AV_COLORS[(it.chat.charCodeAt(0) || i) % AV_COLORS.length]}">${esc(it.chat.slice(0, 1))}</div>
      <div class="info"><div class="name">${esc(it.chat)} ${it.is_group ? '<span class="badge group">群</span>' : ""}</div>
        <div class="last">${esc(it.last || it.username)}</div></div>
      <div class="time">${esc(it.time || day)}</div>
    </div>`;
  }).join("");
  box.querySelectorAll(".chat-item").forEach(el => {
    el.onclick = () => {
      box.querySelectorAll(".chat-item").forEach(x => x.classList.remove("sel"));
      el.classList.add("sel");
      if (el.dataset.import) {
        state.selected = { import_id: el.dataset.import, chat: el.dataset.n };
      } else {
        state.selected = { username: el.dataset.u, chat: el.dataset.n, is_group: el.dataset.g === "1" };
      }
      $("#selectSub").textContent = `对象：${state.selected.chat}${state.selected.is_group ? "（群聊）" : ""}${state.selected.import_id ? "（导入记录）" : ""}`;
    };
  });
}

function bindSelect() {
  $("#searchInput").oninput = (e) => { state.search = e.target.value; renderChatList(); };
  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.onclick = () => {
      state.filter = chip.dataset.filter;
      document.querySelectorAll(".filter-chip").forEach(c => c.classList.toggle("on", c === chip));
      renderChatList();
    };
  });
  document.querySelectorAll("[data-days]").forEach(btn => {
    btn.onclick = () => setPresetDays(+btn.dataset.days);
  });
  $("#btnBackHome").onclick = () => { show("home"); if (state.localMode) loadStatus(); else { loadImports(); } };

  $("#btnAnalyze").onclick = async () => {
    if (!state.selected) return toast("请先选择一个聊天对象");
    state.relation = $("#relationSel").value;
    state.start = $("#dateStart").value || "";
    state.end = $("#dateEnd").value || "";
    show("result");
    $("#resultHero").innerHTML = heroHTML(null, true);
    $("#resultStats").innerHTML = $("#resultInsight").innerHTML = "";
    $("#resultSignals").innerHTML = $("#resultTree").innerHTML = "";
    $("#resultTimeline").innerHTML = $("#resultQa").innerHTML = "";
    $("#resultStats").innerHTML = `<div class="big-loading"><div class="spinner"></div>正在统计聊天记录…</div>`;
    try {
      let pkg = null;
      if (state.localMode) {
        const body = { relation: state.relation, start: state.start || undefined, end: state.end || undefined };
        if (state.selected.import_id) body.import_id = state.selected.import_id;
        else body.chat = state.selected.username || state.selected.chat;
        const r = await api("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        pkg = r.analysis;
      } else {
        const messages = loadSelectedMessages();
        pkg = Engine.analyze(messages, state.relation, state.selected.chat);
      }
      state.analysis = pkg;
      state.ai = null;
      state.view = "rule";
      renderResult();
    } catch (e) {
      $("#resultStats").innerHTML = `<div class="card"><p style="color:var(--red-deep)">❌ 分析失败：${esc(e.message)}</p></div>`;
    }
  };
}

function loadSelectedMessages() {
  if (state.localMode) return null;
  if (state.webMessages && state.webMessagesId === state.selected.import_id) return state.webMessages;
  const msgs = webLoadMessages(state.selected.import_id);
  state.webMessages = msgs || [];
  state.webMessagesId = state.selected.import_id;
  return state.webMessages;
}

function setPresetDays(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  $("#dateStart").value = days > 0 ? fmt(start) : "";
  $("#dateEnd").value = fmt(end);
}

// ---------------- 结果页 ----------------
function currentPkg() { return state.view === "ai" && state.ai ? state.ai : state.analysis; }

function heroHTML(pkg, loading) {
  const meta = pkg?.meta;
  const chips = loading
    ? `<span class="chip">分析中…</span>`
    : `<span class="chip">对象：<b>${esc(meta.chat)}</b></span>
       <span class="chip">关系：<b>${esc(meta.relation_label)}</b></span>
       <span class="chip">时间段：<b>${esc(pkg.stats.first_ts)} ~ ${esc(pkg.stats.last_ts)}</b></span>
       <span class="chip">消息：<b>${pkg.stats.total} 条</b></span>`;
  return `<div class="hero">
    ${chips}
    <h1 style="font-size:26px">聊天复盘 · 策略决策树${state.view === "ai" && state.ai ? " <span class='chip' style='font-size:12px'>AI 深度版</span>" : ""}</h1>
    <p class="sub">${loading ? "" : esc(pkg.insight[0] || "")}</p>
    <div class="btn-row" style="margin-top:16px;position:relative;z-index:1">
      <button class="btn blue" id="btnExport">📥 导出 HTML 报告</button>
      <button class="btn ghost" id="btnAiDeep">🤖 AI 深度分析</button>
      <button class="btn ghost" id="btnViewToggle" style="display:none">切换到规则版</button>
      <button class="btn ghost" id="btnAgain">↺ 换个对象</button>
    </div>
  </div>`;
}

function renderResult() {
  const pkg = currentPkg();
  $("#resultHero").innerHTML = heroHTML(pkg, false);
  $("#resultHero #btnExport").onclick = exportReport;
  $("#resultHero #btnAiDeep").onclick = runAiDeep;
  $("#resultHero #btnAgain").onclick = () => { show("select"); enterSelect(); };
  const toggle = $("#resultHero #btnViewToggle");
  if (state.ai) {
    toggle.style.display = "";
    toggle.textContent = state.view === "ai" ? "切换到规则版" : "切换到 AI 版";
    toggle.onclick = () => { state.view = state.view === "ai" ? "rule" : "ai"; renderResult(); };
  }

  $("#resultStats").innerHTML = statsHTML(pkg);
  $("#resultInsight").innerHTML = insightHTML(pkg);
  $("#resultSignals").innerHTML = signalsHTML(pkg);
  $("#resultTree").innerHTML = treeHTML(pkg);
  $("#resultTimeline").innerHTML = timelineHTML(pkg);
  $("#resultQa").innerHTML = qaHTML();
  bindQa();
  renderCharts(pkg);
}

function statsHTML(pkg) {
  const s = pkg.stats;
  const cards = [
    ["pink", s.total, `有效消息总数（${s.days} 天）`],
    ["blue", s.night_ratio + "%", "深夜（22 点后）占比"],
    ["green", (s.gap_other === null ? "-" : s.gap_other), "对方回复中位间隔（分钟）"],
    ["yellow", `${s.me_ratio}% : ${Math.round((100 - s.me_ratio) * 10) / 10}%`, "你 : 对方 消息占比"],
    ["pink", `${s.init_me} : ${s.init_other}`, "主动开聊次数（你 : 对方）"],
    ["blue", s.voice_other + " 条", "对方发的语音"],
  ].map(([c, num, lab]) => `<div class="stat ${c}"><div class="num">${esc(num)}</div><div class="lab">${esc(lab)}</div></div>`).join("");
  return `<section><div class="sec-head"><span class="dot"></span><h2>① 关系速览</h2></div>
    <div class="stat-grid">${cards}</div>
    <div class="card" style="margin-top:14px">
      <div class="sec-head" style="margin-bottom:4px"><h2 style="font-size:16px">每日消息量</h2><span class="desc">浅蓝 = 你 · 浅粉 = 对方</span></div>
      <div class="chart-row" id="dailyChart"></div>
      <div class="legend"><span><i style="background:var(--blue-deep)"></i>你</span><span><i style="background:var(--pink-deep)"></i>对方</span></div>
      <div class="sec-head" style="margin-top:22px;margin-bottom:4px"><h2 style="font-size:16px">24 小时活跃分布</h2></div>
      <div class="hours" id="hourStrip"></div>
      <div class="split" style="margin-top:22px">
        <div class="donut" id="donut"><div class="center"><b>${s.me_ratio}%</b><span>你的消息占比</span></div></div>
        <div id="topicBox"></div>
      </div>
    </div></section>`;
}

function insightHTML(pkg) {
  return `<section><div class="sec-head"><span class="dot" style="background:var(--green-deep);box-shadow:0 0 0 5px rgba(143,179,131,.18)"></span><h2>② 核心解读</h2></div>
    <div class="card">${(pkg.insight || []).map(p => `<p style="margin:8px 0;font-size:13.5px;color:#7A6557">• ${esc(p)}</p>`).join("")}</div></section>`;
}

function signalsHTML(pkg) {
  const sig = pkg.signals || { green: [], yellow: [], red: [] };
  const one = (items, cls, ico, title) => `<div class="signal ${cls}${cls === "red" ? " wide" : ""}">
    <h3><span class="ico">${ico}</span>${title}</h3><ul>
    ${(items || []).map(i => `<li><b>${esc(i.title)}</b>${i.detail ? `：${esc(i.detail)}` : ""}${i.quote ? ` <span class="q">（${esc(i.quote)}）</span>` : ""}</li>`).join("") || "<li>暂无</li>"}
    </ul></div>`;
  return `<section><div class="sec-head"><span class="dot" style="background:var(--yellow-deep);box-shadow:0 0 0 5px rgba(217,178,95,.18)"></span><h2>③ 信号灯</h2><span class="desc">每条都有聊天记录佐证</span></div>
    <div class="signals">
      ${one(sig.green, "green", "✓", "绿灯 · 关系向好的证据")}
      ${one(sig.yellow, "yellow", "!", "黄灯 · 需要留意")}
      ${one(sig.red, "red", "✕", "红灯 · 绝对不要做")}
    </div></section>`;
}

function treeHTML(pkg) {
  const branches = pkg.tree || [];
  const body = branches.map(b => `<details class="branch"${b.n === "5" ? " open" : ""}>
    <summary><span class="n" style="background:${esc(b.color)}">${esc(b.n)}</span><h4>${esc(b.title)}</h4><span class="caret">▾</span></summary>
    <div class="body"><div class="flow">
      <div class="node cond"><span class="k">判断</span>${esc(b.cond)}</div>
      <div class="arrow">↓</div>
      <div class="node do"><span class="k">行动</span><ul>${(b.do || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div class="arrow">↓</div>
      <div class="node avoid"><span class="k">禁忌</span><ul>${(b.avoid || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>${b.quote ? `<p class="quote">${esc(b.quote)}</p>` : ""}</div>
  </details>`).join("");
  return `<section><div class="sec-head"><span class="dot"></span><h2>④ 策略决策树</h2><span class="desc">点开每个场景查看 判断 → 行动 → 禁忌</span></div>
    <div class="tree-root"><div class="stage">ROOT</div><h3>${esc(pkg.meta.relation_label)} · 复盘决策</h3>
    <p>每个场景对应一条分支，照着走即可。</p></div>
    <div class="tree-trunk"></div>
    <div class="tree-branches">${body}</div></section>`;
}

function timelineHTML(pkg) {
  return `<section><div class="sec-head"><span class="dot" style="background:var(--blue-deep);box-shadow:0 0 0 5px rgba(143,168,201,.18)"></span><h2>⑤ 推进时间轴</h2></div>
    <div class="card"><div class="timeline">
    ${(pkg.timeline || []).map(t => `<div class="t-item"><div class="t-time">${esc(t.phase)}</div><h4>${esc(t.title)}</h4><p>${esc(t.body)}</p></div>`).join("")}
    </div></div></section>`;
}

// ---------------- 图表 ----------------
function renderCharts(pkg) {
  const s = pkg.stats;
  const chart = $("#dailyChart");
  if (!chart) return;
  const days = Object.keys(s.daily);
  const maxV = Math.max(...Object.values(s.daily), 1);
  chart.innerHTML = days.map(d => `
    <div class="bar-col">
      <div class="bar me" style="height:${((s.daily_me[d] || 0) / maxV * 100).toFixed(1)}%"><span class="val">${s.daily_me[d] || 0}</span></div>
      <div class="bar her" style="height:${((s.daily_other[d] || 0) / maxV * 100).toFixed(1)}%;margin-top:2px"><span class="val">${s.daily_other[d] || 0}</span></div>
      <div class="day">${esc(d)}</div>
    </div>`).join("");

  const maxH = Math.max(...s.hours, 1);
  $("#hourStrip").innerHTML = s.hours.map((v, h) => {
    const alpha = v === 0 ? 0.06 : 0.15 + (v / maxH) * 0.85;
    return `<div class="hour" title="${h} 点 · ${v} 条"><b>${h}</b><span class="cell" style="background:rgba(227,157,146,${alpha.toFixed(2)})"></span></div>`;
  }).join("");

  const d = $("#donut");
  d.style.background = `conic-gradient(var(--blue-deep) 0 ${s.me_ratio}%, var(--pink-deep) ${s.me_ratio}% 100%)`;

  const topics = pkg.topics || {};
  const maxT = Math.max(...Object.values(topics), 1);
  $("#topicBox").innerHTML = `<div class="sec-head" style="margin-bottom:4px"><h2 style="font-size:16px">话题热度</h2></div>` +
    Object.entries(topics).slice(0, 8).map(([k, v]) => `
      <div class="topic-row"><span class="tname">${esc(k)}</span>
      <div class="tbar"><div class="tfill" style="width:${(v / maxT * 100).toFixed(0)}%"></div></div>
      <span class="tnum">${v}</span></div>`).join("") || "<p style='color:var(--muted);font-size:13px'>无话题数据</p>";
}

// ---------------- 问答 ----------------
const PRESETS = {
  romance: ["TA 对我有好感吗？", "我该怎么回 TA 最后一条消息？", "什么时候约 TA 见面合适？", "TA 最近的烦恼是什么？", "我的聊天方式有哪些需要改进的？"],
  friend: ["对方最近心情怎么样？", "怎么把关系处得更近？", "约对方出来玩怎么开口？", "我聊天方式有什么可以改进的？"],
  work: ["对方当前最关心什么？", "怎么推进下一步合作？", "我的沟通有什么问题？"],
  family: ["家人最近在担心什么？", "我该怎么多陪陪家人？", "我回复家人的方式有什么问题？"],
};

function qaHTML() {
  const presets = PRESETS[state.relation] || PRESETS.romance;
  const llmOk = state.localMode ? !!state.status?.llm_configured : !!Llm.getConfig().api_key;
  return `<section><div class="sec-head"><span class="dot" style="background:var(--pink-deep);box-shadow:0 0 0 5px rgba(227,157,146,.18)"></span>
    <h2>⑥ 向分析结果提问</h2><span class="desc">基于这份聊天记录回答你的任何问题</span></div>
    <div class="qa-panel">
      <div class="qa-head"><h2>💬 聊天军师</h2>
        <span class="hint">结合上方全部聊天记录回答你——问「TA 对我有好感吗」「这条怎么回」都可以。${llmOk ? "" : "（需要先配置 LLM，见设置）"}</span></div>
      <div class="qa-presets">${presets.map(p => `<span class="p">${esc(p)}</span>`).join("")}</div>
      <div class="qa-log" id="qaLog"></div>
      <div class="qa-input">
        <input type="text" id="qaInput" placeholder="输入你的问题，回车发送…">
        <button class="btn primary small" id="qaSend">发送</button>
      </div>
    </div></section>`;
}

function bindQa() {
  const log = $("#qaLog");
  log.innerHTML = "";
  for (const b of state.qaLog) appendBubble(b);
  log.scrollTop = log.scrollHeight;

  document.querySelectorAll(".qa-presets .p").forEach(p => {
    p.onclick = () => { $("#qaInput").value = p.textContent; sendQa(); };
  });
  $("#qaSend").onclick = sendQa;
  $("#qaInput").onkeydown = (e) => { if (e.key === "Enter") sendQa(); };
}

function appendBubble(b) {
  const log = $("#qaLog");
  const div = document.createElement("div");
  div.className = `qa-bubble ${b.role}`;
  div.innerHTML = `<div class="bubble">${b.role === "bot" ? b.html : esc(b.text)}</div>
    <div class="who">${b.role === "user" ? "我" : "军师"}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function sendQa() {
  const input = $("#qaInput");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  state.qaLog.push({ role: "user", text: q });
  appendBubble(state.qaLog[state.qaLog.length - 1]);

  const loading = document.createElement("div");
  loading.className = "qa-loading";
  loading.innerHTML = `<div class="spinner"></div> 正在结合聊天记录思考…`;
  $("#qaLog").appendChild(loading);
  $("#qaLog").scrollTop = $("#qaLog").scrollHeight;

  try {
    let answer = null;
    if (state.localMode) {
      const body = { question: q, relation: state.relation, start: state.start || undefined, end: state.end || undefined };
      if (state.selected?.import_id) body.import_id = state.selected.import_id;
      else body.chat = state.selected?.username || state.selected?.chat;
      const r = await api("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      answer = r.answer;
    } else {
      const cfg = Llm.getConfig();
      if (!cfg.api_key) throw new Error("尚未配置 AI：请在设置页填写你自己的 OpenAI 兼容 API Key（聊天内容只会发送给你填写的 API）");
      const messages = loadSelectedMessages();
      const stats = Engine.computeStats(messages);
      answer = await Llm.askQuestion(cfg, messages, stats, state.relation, q, state.selected?.chat || "");
    }
    state.qaLog.push({ role: "bot", html: esc(answer).replace(/\n/g, "<br>") });
  } catch (e) {
    state.qaLog.push({ role: "bot", html: `⚠️ ${esc(e.message)}` });
    if (e.message.includes("配置")) openSettings();
  }
  loading.remove();
  appendBubble(state.qaLog[state.qaLog.length - 1]);
}

// ---------------- 导出 / AI ----------------
function exportReport() {
  if (state.localMode) {
    const qs = new URLSearchParams({ relation: state.relation });
    if (state.selected?.import_id) qs.set("import_id", state.selected.import_id);
    else qs.set("chat", state.selected?.username || state.selected?.chat || "");
    if (state.start) qs.set("start", state.start);
    if (state.end) qs.set("end", state.end);
    window.location.href = "/api/export-report?" + qs.toString();
  } else {
    Engine.downloadReport(currentPkg());
  }
}

async function runAiDeep() {
  const btn = $("#btnAiDeep");
  btn.disabled = true;
  btn.textContent = "⏳ AI 分析中（约 1~2 分钟）…";
  try {
    if (state.localMode) {
      const body = { relation: state.relation, start: state.start || undefined, end: state.end || undefined };
      if (state.selected?.import_id) body.import_id = state.selected.import_id;
      else body.chat = state.selected?.username || state.selected?.chat;
      const r = await api("/api/analyze-ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      state.analysis = r.analysis;
      state.ai = r.ai;
    } else {
      const cfg = Llm.getConfig();
      if (!cfg.api_key) throw new Error("尚未配置 AI：请在设置页填写你自己的 OpenAI 兼容 API Key");
      const messages = loadSelectedMessages();
      const base = Engine.analyze(messages, state.relation, state.selected?.chat || "");
      state.analysis = base;
      state.ai = await Llm.deepAnalysis(cfg, messages, base.stats, state.relation, base.meta.chat, base.topics);
    }
    state.view = "ai";
    toast("AI 深度分析完成");
    renderResult();
  } catch (e) {
    toast(e.message);
    if (e.message.includes("配置")) openSettings();
    btn.disabled = false;
    btn.textContent = "🤖 AI 深度分析";
  }
}

// ---------------- 启动 ----------------
function init() {
  bindHome();
  bindSelect();
  bindSettings();
  const today = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  $("#dateEnd").value = fmt(today);
  $("#dateStart").value = fmt(new Date(today.getTime() - 30 * 86400000));

  detectMode().then(() => {
    if (state.localMode) {
      $("#webBanner").classList.add("hidden");
      $("#localSections").style.display = "";
      $("#importSectionTitle").textContent = "③ 手动导入聊天记录";
      $("#importSectionDesc").textContent = "Mac / 微信 3.x / 自动提取失败时使用";
      $("#llmSaveHint").innerHTML = "用于「AI 深度分析」和「交互式问答」。Key 仅保存在本机 <code>data/llm_config.json</code>。";
      loadStatus();
    } else {
      $("#webBanner").classList.remove("hidden");
      $("#localSections").style.display = "none";
      $("#importSectionTitle").textContent = "② 导入聊天记录";
      $("#importSectionDesc").textContent = "文件只在你的浏览器里解析，不会上传";
      $("#llmExplain").innerHTML = "离线分析引擎直接在你的浏览器里运行，不依赖任何服务器。配置你自己的 OpenAI 兼容 API 后，可解锁 <b>AI 深度分析</b> 和 <b>交互式问答</b>（Key 保存在本浏览器，聊天内容只发送给你填写的 API）。";
      $("#llmSaveHint").innerHTML = "用于「AI 深度分析」和「交互式问答」。Key 仅保存在<b>本浏览器 localStorage</b>。";
      $("#llmStateText").textContent = Llm.getConfig().api_key ? "已配置" : "未配置";
      loadImports();
    }
  });
}
init();
