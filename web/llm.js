/* 微信聊天分析站 · 浏览器直连 LLM（OpenAI 兼容）
 * Key 保存在本浏览器 localStorage，聊天内容只发送给你填写的 API。
 */
"use strict";

const Llm = (() => {
  const LS_KEY = "wxci_llm";
  const RELATION_ROLE = {
    romance: "你是资深的聊天关系顾问，擅长分析暧昧/恋爱关系中的信号，给出克制、具体、可执行的建议。",
    friend: "你是资深的人际关系顾问，擅长朋友关系的维护与加深。",
    work: "你是资深的职场沟通顾问，擅长商务谈判、客户关系与需求推进。",
    family: "你是资深的情感顾问，擅长家人/长辈关系的经营与陪伴。",
  };

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { return {}; }
  }
  function setConfig(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }
  function clearKey() { const c = getConfig(); delete c.api_key; setConfig(c); }

  async function chatCompletion(cfg, system, user, temperature = 0.7, maxTokens = 1200) {
    const base = (cfg.base_url || "").trim().replace(/\/+$/, "");
    if (!base || !cfg.api_key) throw new Error("尚未配置 AI：请在设置页填写你自己的 OpenAI 兼容 API Key（Key 只存在本浏览器）");
    const payload = {
      model: cfg.model || "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature, max_tokens: maxTokens,
    };
    const urls = [base + "/chat/completions"];
    if (!base.endsWith("/v1")) urls.push(base + "/v1/chat/completions");
    let lastErr = null;
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.api_key}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`API 返回 ${res.status}: ${txt.slice(0, 240)}`);
        }
        const data = await res.json();
        return data.choices[0].message.content;
      } catch (e) {
        if (e.message && e.message.startsWith("API 返回")) throw e; // 服务端明确响应，不再换 URL
        lastErr = e;
      }
    }
    throw new Error(`无法连接 API: ${lastErr ? lastErr.message : "未知错误"}（浏览器直连要求该 API 允许跨域访问）`);
  }

  // ---------------- 检索 ----------------
  function splitTerms(question) {
    const terms = String(question).split(/[\s,，。？！？、;；]+/).filter(Boolean);
    for (const t of [...terms]) {
      if (/[\u4e00-\u9fff]/.test(t)) {
        for (let i = 0; i < t.length - 1; i++) terms.push(t.slice(i, i + 2));
      }
    }
    return [...new Set(terms)].filter(t => t.length >= 2);
  }

  function retrieve(messages, question, topN = 30, maxChars = 5000) {
    const terms = splitTerms(question);
    const scored = [];
    messages.forEach((m, idx) => {
      const t = m.text || "";
      let score = 0;
      for (const term of terms) if (t.includes(term)) score += 1;
      if (score > 0) scored.push([score, idx]);
    });
    scored.sort((a, b) => b[0] - a[0]);
    const picked = new Set();
    for (const [, idx] of scored.slice(0, topN)) {
      for (let j = Math.max(0, idx - 2); j < Math.min(messages.length, idx + 3); j++) picked.add(j);
    }
    for (let j = Math.max(0, messages.length - 10); j < messages.length; j++) picked.add(j);
    const lines = []; let used = 0;
    for (const j of [...picked].sort((a, b) => a - b)) {
      const m = messages[j];
      const line = `[${m.time}] ${m.sender}: ${m.text}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  function statsBrief(stats, relation) {
    return `消息总数 ${stats.total}，双方占比 ${stats.me_ratio}%:${Math.round((100 - stats.me_ratio) * 10) / 10}%，` +
      `天数 ${stats.days}，深夜(22点后)占比 ${stats.night_ratio}%，对方回复中位间隔 ${stats.gap_other} 分钟，` +
      `主动开聊次数 你 ${stats.init_me} : 对方 ${stats.init_other}，语音 对方 ${stats.voice_other} 条，撤回 ${stats.revoke} 次，` +
      `消息类型分布 ${JSON.stringify(stats.types)}`;
  }

  // ---------------- 问答 ----------------
  async function askQuestion(cfg, messages, stats, relation, question, chatName = "") {
    const system = (RELATION_ROLE[relation] || RELATION_ROLE.romance) +
      " 你会拿到一段真实的聊天记录（发送者标为 me=用户本人 / other=对方）和统计数据。" +
      "请像一位熟悉全部对话细节的军师一样回答用户的问题：先给直接结论，再给 1~3 条具体可执行的做法，尽量引用对话原文细节佐证；" +
      "如果记录不足以支撑，明确说明并给通用建议。回答控制在 280 字以内，语气自然，不说教。";
    const context = retrieve(messages, question);
    const user = `聊天对象：${chatName || "未知"}\n关系类型：${relation}\n` +
      `统计数据：${statsBrief(stats, relation)}\n\n` +
      `相关聊天记录（按时间）:\n${context || "（未检索到明显相关内容）"}\n\n` +
      `用户的问题：${question}`;
    return await chatCompletion(cfg, system, user, 0.7, 900);
  }

  // ---------------- 深度分析 ----------------
  async function deepAnalysis(cfg, messages, stats, relation, chatName = "", topics = null) {
    const system = (RELATION_ROLE[relation] || RELATION_ROLE.romance) +
      " 你会拿到一段真实聊天记录与统计数据，请输出 JSON（不要任何多余文字）完成深度分析。";
    const user = `聊天对象：${chatName || "未知"}\n关系类型：${relation}\n` +
      `统计数据：${statsBrief(stats, relation)}\n话题分布：${JSON.stringify(topics || {})}\n\n` +
      `聊天记录（发送者 me=用户本人）:\n${bundle(messages, 9000)}\n\n` +
      '请输出如下 JSON 结构（字段齐全、可被 JSON.parse 解析）：\n' +
      '{"insight": ["3-4条总解读"],\n' +
      ' "signals": {"green": [{"title":"标题","detail":"证据+含义"}], "yellow": [{"title":"标题","detail":"风险+建议"}], "red": [{"title":"禁忌一句话"}]},\n' +
      ' "tree": [8个分支, 每个: {"n":"1","title":"场景","color":"#E39D92","cond":"判断条件","do":["行动1"],"avoid":["禁忌1"],"quote":"可引用的对话原话或空"}],\n' +
      ' "timeline": [{"phase":"阶段一","title":"标题","body":"做法"}]}\n' +
      '要求：green 3-5 条、yellow 3-4 条、red 4-6 条、tree 恰好 8 个分支覆盖（对方主动/我主动/冷场/情绪低落/推进见面或推进关系/竞争者/升温节点/长期维护）、timeline 3-4 条。';
    const text = await chatCompletion(cfg, system, user, 0.6, 3000);
    let t = text.trim();
    const m = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(t);
    if (m) t = m[1];
    try { return JSON.parse(t); } catch (e) {
      const start = t.indexOf("{"), end = t.lastIndexOf("}");
      if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch (e2) {} }
      throw new Error("AI 输出无法解析为 JSON，请重试或换一个模型");
    }
  }

  function bundle(messages, maxChars) {
    const lines = []; let used = 0;
    for (const m of messages) {
      const line = `[${m.time}] ${m.sender}: ${m.text}`;
      if (used + line.length > maxChars) { lines.push("……（中间省略）……"); break; }
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  return { getConfig, setConfig, clearKey, askQuestion, deepAnalysis, retrieve };
})();
