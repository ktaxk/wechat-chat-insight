/* 微信聊天分析站 · 导入解析（纯前端版，与 local/wechat_adapter.parse_import 逻辑一致）
 * 支持: wechat-cli history JSON / 「[时间] 昵称: 内容」文本 / CSV
 */
"use strict";

const Importer = (() => {
  const LINE_RE1 = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,30})[:：]\s*(.*)$/;
  const LINE_RE2 = /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)[ T](\d{1,2}[:时]\d{2}(?:[:分]\d{2})?)\s+([^:：\s]{1,30})[:：]\s*(.*)$/;
  const ME_LABELS = new Set(["me", "我", "自己", "self", "i", "本人"]);
  const TYPE_TAGS = [
    ["[表情]", 47], ["[图片]", 3], ["[语音]", 34], ["[视频]", 43],
    ["[撤回]", 10002], ["[系统]", 10000], ["[文件]", 49], ["[链接", 49], ["[通话]", 50],
  ];
  const TYPE_LABELS = { 1: "文本", 3: "图片", 34: "语音", 42: "名片", 43: "视频",
    47: "表情", 48: "位置", 49: "链接/文件", 50: "通话", 10000: "系统", 10002: "撤回" };

  const normSender = (label) => ME_LABELS.has(String(label || "").trim().toLowerCase()) ? "me" : "other";
  const guessType = (text) => {
    for (const [tag, bt] of TYPE_TAGS) if ((text || "").startsWith(tag)) return bt;
    return 1;
  };

  function parseTs(value, isEnd = false) {
    if (!value) return null;
    const s = String(value).trim().replace(/\//g, "-");
    const formats = [
      ["%Y-%m-%d %H:%M:%S", false], ["%Y-%m-%d %H:%M", false], ["%Y-%m-%d", true],
    ];
    for (const [fmt, dateOnly] of formats) {
      const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (!m) continue;
      const [, Y, Mo, D, H, Mi, Se] = m;
      const dt = new Date(+Y, +Mo - 1, +D, H ? +H : (dateOnly && isEnd ? 23 : 0), Mi ? +Mi : (dateOnly && isEnd ? 59 : 0), Se ? +Se : (dateOnly && isEnd ? 59 : 0));
      if (isNaN(dt.getTime())) continue;
      return Math.floor(dt.getTime() / 1000);
    }
    return null;
  }

  const fmtTime = (ts) => {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function finish(msgs, name) {
    const out = msgs.filter(m => m.ts).map(m => ({
      ts: m.ts, time: m.time || fmtTime(m.ts),
      sender: m.sender, sender_username: "",
      type: m.type, type_label: TYPE_LABELS[m.type] || String(m.type),
      text: String(m.text || ""),
    }));
    out.sort((a, b) => a.ts - b.ts);
    return { chat: name || "导入记录", username: "", is_group: false, messages: out, imported: true };
  }

  function parseImport(content, name = "") {
    content = String(content || "").replace(/^\ufeff/, "");
    if (!content.trim()) throw new Error("导入内容为空");

    // 1) JSON
    if (content.trim().startsWith("{")) {
      let data;
      try { data = JSON.parse(content); } catch (e) { throw new Error("JSON 解析失败"); }
      const raw = Array.isArray(data) ? data : (data.messages || []);
      if (!Array.isArray(raw)) throw new Error("不支持的 JSON 结构（需要 messages 数组）");
      const msgs = raw.map(item => {
        if (typeof item === "string") {
          const m = LINE_RE1.exec(item);
          if (!m) return null;
          const ts = parseTs(m[1] + " " + m[2]);
          const text = m[4];
          return { ts, time: m[1] + " " + m[2], sender: normSender(m[3]), type: guessType(text), text };
        }
        if (item && typeof item === "object") {
          const ts = typeof item.ts === "number" ? item.ts
            : typeof item.timestamp === "number" ? item.timestamp
            : typeof item.create_time === "number" ? item.create_time
            : parseTs(item.time || item.timestamp || item.create_time);
          const text = String(item.text ?? item.content ?? "");
          return { ts, time: item.time || (ts ? fmtTime(ts) : ""),
            sender: normSender(item.sender ?? item.sender_name ?? item.real_sender_id),
            type: item.type || (text ? 1 : 0), text };
        }
        return null;
      }).filter(Boolean);
      if (!msgs.length) throw new Error("JSON 中未解析到消息");
      return finish(msgs, name || (data.chat && typeof data.chat === "string" ? data.chat : ""));
    }

    // 2) 文本行
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      const m = LINE_RE1.exec(line) || LINE_RE2.exec(line);
      if (!m) continue;
      let [, day, hhmm, sender, text] = m;
      day = day.replace(/年/g, "-").replace(/月/g, "-").replace(/日/g, "");
      hhmm = hhmm.replace(/时/g, ":").replace(/分/g, "");
      const ts = parseTs(day + " " + hhmm);
      if (ts === null) continue;
      parsed.push({ ts, time: fmtTime(ts), sender: normSender(sender), type: guessType(text), text });
    }
    if (parsed.length > lines.length / 2) return finish(parsed, name);

    // 3) CSV
    const sniff = (() => {
      const head = content.slice(0, 4096);
      const counts = { ",": 0, ";": 0, "\t": 0 };
      for (const line of head.split(/\r?\n/).slice(0, 10)) {
        if (line.startsWith("[")) return null; // 文本行格式
        for (const ch of Object.keys(counts)) counts[ch] += (line.split(ch).length - 1);
      }
      const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      return counts[best] > 0 ? best : null;
    })();
    if (!sniff) throw new Error("无法识别格式：请提供 wechat-cli JSON、聊天文本或 CSV");
    const splitRow = (line) => {
      // 简单 CSV 解析（支持引号）
      const out = []; let cur = "", inQ = false;
      for (const ch of line) {
        if (inQ) { if (ch === '"') inQ = false; else cur += ch; }
        else if (ch === '"') inQ = true;
        else if (ch === sniff) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const rows = content.split(/\r?\n/).filter(Boolean).map(splitRow);
    if (!rows.length) throw new Error("CSV 为空");
    const header = rows[0].map(h => String(h).trim().toLowerCase());
    const cols = {};
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      if (!("时间" in cols) && /时间|日期|time|date/.test(h)) cols["时间"] = i;
      else if (!("发送" in cols) && /发送|sender|from|昵称|name/.test(h)) cols["发送"] = i;
      else if (!("内容" in cols) && /内容|消息|content|text|msg/.test(h)) cols["内容"] = i;
    }
    if (Object.keys(cols).length < 3) throw new Error("CSV 缺少列：需要 时间/发送者/内容 三列");
    const msgs = [];
    for (const row of rows.slice(1)) {
      if (row.length < 3 || !row[cols["时间"]].trim()) continue;
      const ts = parseTs(row[cols["时间"]]);
      if (ts === null) continue;
      const text = row[cols["内容"]];
      msgs.push({ ts, time: fmtTime(ts), sender: normSender(row[cols["发送"]]), type: guessType(text), text });
    }
    return finish(msgs, name);
  }

  return { parseImport, parseTs, fmtTime };
})();
