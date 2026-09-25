# -*- coding: utf-8 -*-
"""可选 AI 模块：深度分析 + 基于聊天记录的检索式问答。

调用用户自己配置的 OpenAI 兼容 API（base_url + model + api_key，存于本机）。
不配置 API 时，本模块不会被调用，离线规则引擎照常工作。
"""
import json
import re
import urllib.error
import urllib.request

RELATION_ROLE = {
    "romance": "你是资深的聊天关系顾问，擅长分析暧昧/恋爱关系中的信号，给出克制、具体、可执行的建议。",
    "friend": "你是资深的人际关系顾问，擅长朋友关系的维护与加深。",
    "work": "你是资深的职场沟通顾问，擅长商务谈判、客户关系与需求推进。",
    "family": "你是资深的情感顾问，擅长家人/长辈关系的经营与陪伴。",
}


def chat_completion(cfg, system, user, temperature=0.6, max_tokens=2600):
    """调用 OpenAI 兼容接口，返回文本。"""
    base = (cfg.get("base_url") or "").strip().rstrip("/")
    if not base or not cfg.get("api_key"):
        raise RuntimeError("未配置 LLM：请在设置中填写 API 地址与 Key")
    payload = {
        "model": cfg.get("model") or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    urls = [base + "/chat/completions"]
    if not base.endswith("/v1"):
        urls.append(base + "/v1/chat/completions")
    last_err = None
    for url in urls:
        req = urllib.request.Request(url, data=body, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['api_key']}",
        })
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            last_err = RuntimeError(f"API 返回 {e.code}: {e.read().decode('utf-8', errors='replace')[:300]}")
        except urllib.error.URLError as e:
            last_err = RuntimeError(f"无法连接 API: {e.reason}")
        except Exception as e:
            last_err = RuntimeError(f"API 调用失败: {e}")
    raise last_err


# ---------------------------------------------------------------- 检索

def _split_terms(question):
    terms = [t for t in re.split(r"[\s,，。？！？、;；]+", question) if t]
    for t in list(terms):
        if re.search(r"[\u4e00-\u9fff]", t):
            terms += [t[i:i + 2] for i in range(len(t) - 1)]
    seen = set()
    out = []
    for t in terms:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def retrieve(messages, question, top_n=30, max_chars=5000):
    """按问题关键词检索相关消息（含上下文窗口），返回压缩文本。"""
    terms = _split_terms(question)
    scored = []
    for idx, m in enumerate(messages):
        t = m.get("text") or ""
        score = sum(t.count(term) for term in terms if term and len(term) >= 2)
        if score > 0:
            scored.append((score, idx))
    scored.sort(key=lambda x: -x[0])
    picked = set()
    for _score, idx in scored[:top_n]:
        for j in range(max(0, idx - 2), min(len(messages), idx + 3)):
            picked.add(j)
    # 加上最近 10 条
    for j in range(max(0, len(messages) - 10), len(messages)):
        picked.add(j)
    lines, used = [], 0
    for j in sorted(picked):
        m = messages[j]
        line = f"[{m['time']}] {m['sender']}: {m['text']}"
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


# ---------------------------------------------------------------- 统计摘要

def stats_brief(stats, relation):
    return (
        f"消息总数 {stats['total']}，双方占比 {stats['me_ratio']}%:{round(100 - stats['me_ratio'], 1)}%，"
        f"天数 {stats['days']}，深夜(22点后)占比 {stats['night_ratio']}%，"
        f"对方回复中位间隔 {stats['gap_other']} 分钟，"
        f"主动开聊次数 你 {stats['init_me']} : 对方 {stats['init_other']}，"
        f"语音 对方 {stats['voice_other']} 条，撤回 {stats['revoke']} 次，"
        f"消息类型分布 {json.dumps(stats['types'], ensure_ascii=False)}"
    )


# ---------------------------------------------------------------- 问答

def ask_question(cfg, messages, stats, relation, question, chat_name=""):
    system = (
        RELATION_ROLE.get(relation, RELATION_ROLE["romance"])
        + " 你会拿到一段真实的聊天记录（发送者标为 me=用户本人 / other=对方）和统计数据。"
        + "请像一位熟悉全部对话细节的军师一样回答用户的问题："
        + "先给直接结论，再给 1~3 条具体可执行的做法，尽量引用对话原文细节佐证；"
        + "如果记录不足以支撑，明确说明并给通用建议。回答控制在 280 字以内，语气自然，不说教。"
    )
    context = retrieve(messages, question)
    user = (
        f"聊天对象：{chat_name or '未知'}\n关系类型：{relation}\n"
        f"统计数据：{stats_brief(stats, relation)}\n\n"
        f"相关聊天记录（按时间）:\n{context or '（未检索到明显相关内容）'}\n\n"
        f"用户的问题：{question}"
    )
    return chat_completion(cfg, system, user, temperature=0.7, max_tokens=900)


# ---------------------------------------------------------------- 深度分析

def deep_analysis(cfg, messages, stats, relation, chat_name="", topics=None):
    system = (
        RELATION_ROLE.get(relation, RELATION_ROLE["romance"])
        + " 你会拿到一段真实聊天记录与统计数据，请输出 JSON（不要任何多余文字）完成深度分析。"
    )
    bundle = _bundle(messages, 9000)
    user = (
        f"聊天对象：{chat_name or '未知'}\n关系类型：{relation}\n"
        f"统计数据：{stats_brief(stats, relation)}\n"
        f"话题分布：{json.dumps(topics or {}, ensure_ascii=False)}\n\n"
        f"聊天记录（发送者 me=用户本人）:\n{bundle}\n\n"
        '请输出如下 JSON 结构（字段齐全、可被 json.loads 解析）：\n'
        '{"insight": ["3-4条总解读，每条一句话，结合真实对话细节"],\n'
        ' "signals": {"green": [{"title":"标题","detail":"证据+含义"}], "yellow": [{"title":"标题","detail":"风险+建议"}], "red": [{"title":"禁忌一句话"}]},\n'
        ' "tree": [8个分支, 每个: {"n":"1","title":"场景","color":"#E39D92","cond":"判断条件","do":["行动1"],"avoid":["禁忌1"],"quote":"可引用的对话原话或空"}] ,\n'
        ' "timeline": [{"phase":"阶段一","title":"标题","body":"做法"}]}\n'
        '要求：green 3-5 条、yellow 3-4 条、red 4-6 条、tree 恰好 8 个分支覆盖（对方主动/我主动/冷场/情绪低落/推进见面或推进关系/竞争者/升温节点/长期维护）、timeline 3-4 条。'
    )
    text = chat_completion(cfg, system, user, temperature=0.6, max_tokens=3000)
    text = text.strip()
    # 容忍模型输出 markdown 代码块
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
        raise RuntimeError("AI 输出无法解析为 JSON，请重试或换一个模型")


def _bundle(messages, max_chars):
    lines, used = [], 0
    for m in messages:
        line = f"[{m['time']}] {m['sender']}: {m['text']}"
        if used + len(line) > max_chars:
            lines.append("……（中间省略）……")
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)
