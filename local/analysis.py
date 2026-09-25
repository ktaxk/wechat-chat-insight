# -*- coding: utf-8 -*-
"""离线分析引擎：统计、好感/风险信号检测、决策树、时间轴、报告渲染。

不依赖任何外部服务；产出 JSON 分析包 + 可下载的独立 HTML 报告。
"""
import datetime
import html
import json
import re

# ---------------------------------------------------------------- 基础工具

def _median(vals):
    if not vals:
        return None
    s = sorted(vals)
    return s[len(s) // 2]


def _avg(vals):
    return round(sum(vals) / len(vals), 1) if vals else None


def _is_me(m):
    return m.get("sender") == "me"


def _has_cjk(t):
    return bool(re.search(r"[\u4e00-\u9fff]", t or ""))


def find_quote(messages, sender=None, regex=None, exclude_no_cjk=True, max_len=60):
    """从真实消息里抽一句可引用的原话。"""
    for m in messages:
        if sender is not None and m["sender"] != sender:
            continue
        t = (m.get("text") or "").strip()
        if not t or t.startswith("["):
            continue
        t = t.split("\n", 1)[0].strip()  # 去掉引用回复的尾巴
        if exclude_no_cjk and not _has_cjk(t):
            continue
        if regex and not re.search(regex, t):
            continue
        t = re.sub(r"\s+", " ", t)
        return t[:max_len] + ("…" if len(t) > max_len else "")
    return None


# ---------------------------------------------------------------- 关系类型配置

RELATIONS = {
    "romance": {
        "label": "暧昧/恋爱对象",
        "me": "你", "other": "TA",
        "topics": {
            "日常分享": ["吃", "饭", "食堂", "外卖", "奶茶", "咖啡", "喝", "零食"],
            "兴趣爱好": ["音乐", "歌", "游戏", "电影", "剧", "综艺", "书", "乐队", "番"],
            "学习工作": ["课", "作业", "考试", "复习", "实验", "上班", "加班", "项目", "自习"],
            "生活校园": ["宿舍", "寝室", "学校", "教室", "食堂", "操场", "校园", "宿舍"],
            "情绪压力": ["累", "压力", "忙", "困", "崩溃", "烦", "焦虑", "难"],
            "暧昧升温": ["晚安", "早安", "想你", "抱抱", "爱心", "❤", "喜欢", "拍", "学长", "学妹"],
        },
        "red": [
            "别在还没线下相处时突然表白——把暧昧期的主动权一次押光。",
            "别追问 TA 撤回的内容，装没看见，安全感比好奇心值钱。",
            "别审问式聊天（连续抛问题），聊天不是面试。",
            "别重复使用被婉拒过的邀约场景，换一个再约。",
            "别吃醋式盘问其他追求者，大气和自信才是降维打击。",
            "别在 TA 明确说忙（上课/加班）时要求即时回应。",
        ],
    },
    "friend": {
        "label": "朋友/同学",
        "me": "你", "other": "对方",
        "topics": {
            "日常分享": ["吃", "饭", "玩", "出去", "聚", "逛街", "打球"],
            "兴趣爱好": ["游戏", "音乐", "电影", "剧", "动漫", "球", "健身", "综艺"],
            "学习工作": ["课", "作业", "考试", "实习", "工作", "面试", "考研"],
            "吐槽调侃": ["哈哈", "笑死", "绷", "离谱", "服了", "绝了", "牛"],
            "情绪倾诉": ["累", "烦", "压力", "难过", "伤心", "失恋", "崩溃"],
            "互相帮助": ["帮", "借", "问一下", "麻烦", "谢谢", "感谢"],
        },
        "red": [
            "别只在有求于对方时才出现——平时不维系，用时方恨少。",
            "别把对方的倾诉当玩笑，朋友也会记仇。",
            "别单方面倾倒负能量，长期单向输出会耗光耐心。",
            "别拿对方的糗事在公开场合反复调侃。",
            "别爽约——朋友关系的信用账户很容易透支。",
        ],
    },
    "work": {
        "label": "职场/客户",
        "me": "你", "other": "对方",
        "topics": {
            "需求推进": ["需求", "方案", "报价", "合同", "付款", "交付", "验收", "排期"],
            "业务沟通": ["项目", "产品", "会议", "邮件", "报告", "数据", "对接"],
            "关系维护": ["吃饭", "喝茶", "咖啡", "活动", "参观", "聊"],
            "问题处理": ["问题", "bug", "故障", "延期", "投诉", "改", "急"],
            "寒暄问候": ["节日", "周末", "假期", "天气", "家人", "身体"],
        },
        "red": [
            "别发 60 秒长语音轰炸——职场沟通文字优先。",
            "别把个人情绪带进商务对话。",
            "别轻易承诺做不到的交付时间，信任成本极高。",
            "别越过对方的工作边界（跳过对接人直接找上级）。",
            "别在对方明确下班/休假时持续推业务。",
        ],
    },
    "family": {
        "label": "家人/长辈",
        "me": "你", "other": "对方",
        "topics": {
            "日常问候": ["吃", "睡", "身体", "注意", "天气", "降温", "穿"],
            "生活近况": ["学校", "工作", "学习", "考试", "忙", "累"],
            "家常事务": ["家里", "爸妈", "奶奶", "爷爷", "亲戚", "回家"],
            "关心叮嘱": ["注意", "小心", "照顾", "别熬", "多吃"],
            "倾诉回忆": ["以前", "小时候", "当年", "想"],
        },
        "red": [
            "别对关心敷衍了事——「嗯」「哦」是家人关系最大的冷暴力。",
            "别只在缺钱/有事时才想起联系。",
            "别和长辈硬杠对错，先接住情绪再谈道理。",
            "别报忧不报喜太久，家人会一直悬着心。",
            "别把最坏的脾气留给最亲的人。",
        ],
    },
}


# ---------------------------------------------------------------- 统计

def compute_stats(messages):
    msgs = [m for m in messages if m.get("ts")]
    if not msgs:
        return None
    me_n = sum(1 for m in msgs if _is_me(m))
    total = len(msgs)
    other_n = total - me_n

    daily, daily_me, daily_other = {}, {}, {}
    hours = [0] * 24
    hours_me = [0] * 24
    hours_other = [0] * 24
    types, types_me, types_other = {}, {}, {}
    night = 0
    for m in msgs:
        dt = datetime.datetime.fromtimestamp(m["ts"])
        k = dt.strftime("%m-%d")
        daily[k] = daily.get(k, 0) + 1
        hours[dt.hour] += 1
        if _is_me(m):
            daily_me[k] = daily_me.get(k, 0) + 1
            hours_me[dt.hour] += 1
            t = m.get("type_label") or "其他"
            types_me[t] = types_me.get(t, 0) + 1
        else:
            daily_other[k] = daily_other.get(k, 0) + 1
            hours_other[dt.hour] += 1
            t = m.get("type_label") or "其他"
            types_other[t] = types_other.get(t, 0) + 1
        types[t] = types.get(t, 0) + 1
        if dt.hour >= 22 or dt.hour < 2:
            night += 1

    def gaps(sender):
        seq = [m["ts"] for m in msgs if m["sender"] == sender]
        g = []
        for i in range(1, len(seq)):
            dmin = (seq[i] - seq[i - 1]) / 60.0
            if 0.2 < dmin < 600:
                g.append(dmin)
        return g

    def initiations(sender):
        cnt = 0
        prev = None
        for m in msgs:
            if prev is None or (m["ts"] - prev["ts"]) / 60.0 > 60:
                if m["sender"] == sender:
                    cnt += 1
            prev = m
        return cnt

    first, last = msgs[0]["ts"], msgs[-1]["ts"]
    return {
        "first_ts": msgs[0]["time"], "last_ts": msgs[-1]["time"],
        "days": max(1, (last - first) // 86400 + 1),
        "total": total, "me_n": me_n, "other_n": other_n,
        "me_ratio": round(me_n / total * 100, 1) if total else 0,
        "daily": dict(sorted(daily.items())), "daily_me": dict(sorted(daily_me.items())),
        "daily_other": dict(sorted(daily_other.items())),
        "hours": hours, "hours_me": hours_me, "hours_other": hours_other,
        "night_ratio": round(night / total * 100, 1) if total else 0,
        "gap_me": _median(gaps("me")), "gap_other": _median(gaps("other")),
        "init_me": initiations("me"), "init_other": initiations("other"),
        "types": dict(sorted(types.items(), key=lambda x: -x[1])),
        "types_me": dict(sorted(types_me.items(), key=lambda x: -x[1])),
        "types_other": dict(sorted(types_other.items(), key=lambda x: -x[1])),
        "voice_me": types_me.get("语音", 0), "voice_other": types_other.get("语音", 0),
        "sticker_me": types_me.get("表情", 0), "sticker_other": types_other.get("表情", 0),
        "revoke": types.get("撤回", 0),
    }


def compute_topics(messages, relation):
    kws = RELATIONS[relation]["topics"]
    counts = {}
    for m in messages:
        t = m.get("text") or ""
        for topic, words in kws.items():
            if any(w in t for w in words):
                counts[topic] = counts.get(topic, 0) + 1
    return dict(sorted(counts.items(), key=lambda x: -x[1]))


# ---------------------------------------------------------------- 信号检测

def detect_signals(messages, stats, relation):
    me_msgs = [m for m in messages if _is_me(m)]
    other_msgs = [m for m in messages if not _is_me(m)]
    rel = RELATIONS[relation]
    me, other = rel["me"], rel["other"]
    green, yellow = [], []

    def g(title, detail, quote=None):
        item = {"title": title, "detail": detail}
        if quote:
            item["quote"] = quote
        green.append(item)

    def y(title, detail, quote=None):
        item = {"title": title, "detail": detail}
        if quote:
            item["quote"] = quote
        yellow.append(item)

    # ---- 通用绿灯 ----
    if stats["night_ratio"] >= 20:
        g("深夜陪伴", f"22 点后的聊天占 {stats['night_ratio']}%，愿意把睡前的私人时间留给你，是关系深度的重要指标。")
    if stats["gap_other"] is not None and stats["gap_other"] <= 2:
        g("热聊节奏", f"{other} 回复你的中位间隔只有 {stats['gap_other']} 分钟，聊天状态是「即问即答」。")
    if stats["voice_other"] > 0:
        g("语音消息", f"{other} 发过 {stats['voice_other']} 条语音。愿意开口说话，比打字更进一步。")
    share_q = find_quote(other_msgs, regex=r"刚刚|正在|正准备|我去|我先|到家|在图书馆|在教室|下课|去上课|回来")
    if share_q:
        g("主动报备", f"{other} 会主动向你同步行踪和生活动态，这是信任和「想让你知道」的信号。", share_q)
    cur_q = find_quote(other_msgs, regex=r"你呢|怎么|为什么|啥")
    if cur_q:
        g("双向好奇", f"{other} 不只是回答问题，也会反过来追问你——单方面的聊天走不远。", cur_q)
    if stats["init_other"] >= 2:
        g("主动开聊", f"这段时间 {other} 主动挑起新话题 {stats['init_other']} 次，关系不是单方拉动。")
    stress_q = find_quote(other_msgs, regex=r"压力|累|忙|困|崩溃|烦|焦虑|难过|难")
    if stress_q:
        g("自我袒露", f"{other} 向你袒露过情绪状态，人只会对信任的人示弱。", stress_q)
    if stats["revoke"] >= 3:
        g("在意形象", f"对话中有 {stats['revoke']} 次撤回记录，说明 {other} 在意在你面前的表达质量。")

    # ---- 关系专属绿灯 ----
    if relation == "romance":
        pat_q = find_quote(messages, regex=r"拍了拍")
        if pat_q:
            g("肢体语言式互动", "拍一拍、亲昵表情这类「小动作」频繁出现，是暧昧升温的典型表现。", pat_q)
        night_q = find_quote(messages, regex=r"晚安|早安")
        if night_q:
            g("早晚问候", "「晚安」不只是礼貌，是给这一天画上句号的仪式感。", night_q)
    elif relation == "friend":
        if stats["sticker_other"] >= stats["total"] * 0.05:
            g("表情包文化", f"{other} 和你斗图 {stats['sticker_other']} 次，玩梗顺畅是关系松弛的证明。")
        help_q = find_quote(other_msgs, regex=r"帮|问一下|麻烦|谢谢")
        if help_q:
            g("互助关系", f"{other} 会放心地开口找你帮忙，说明你在他/她心里是「靠得住的人」。", help_q)
    elif relation == "work":
        if stats["gap_other"] is not None and stats["gap_other"] <= 30:
            g("响应及时", f"{other} 回复中位间隔 {stats['gap_other']} 分钟，合作意愿和优先级都很高。")
        biz_q = find_quote(other_msgs, regex=r"需求|方案|报价|合同|交付|确认|推进")
        if biz_q:
            g("务实推进", f"{other} 主动推进业务话题，比客套话有分量得多。", biz_q)
    elif relation == "family":
        care_q = find_quote(other_msgs, regex=r"注意|小心|照顾|别熬|多吃|穿|身体|睡")
        if care_q:
            g("关心叮嘱", "长辈式的具体关心，是家人独有的表达方式。", care_q)
        if stats["init_other"] >= 1:
            g("主动联系", f"{other} 主动找过你 {stats['init_other']} 次，家人开口前往往已经想你好几天了。")

    # ---- 通用黄灯 ----
    if stats["me_ratio"] >= 57 and relation in ("romance", "friend"):
        y("消息量倒挂", f"你占 {stats['me_ratio']}%，{other} 占 {round(100 - stats['me_ratio'], 1)}%。长期倒挂会稀释吸引力和对方的主动性，试着少说一点、多引对方说。")
    dep_q = find_quote(me_msgs, regex=r"抱歉|对不起|冒昧|见笑|打扰|我菜|我真笨")
    if dep_q:
        y("自我贬低偏多", "过度谦卑会削弱吸引力，把「抱歉/见笑」换成陈述事实。", dep_q)
    if stats["revoke"] >= 5:
        y("撤回频繁", f"对话中有 {stats['revoke']} 次撤回。TA 在意你的看法——别追问被撤回的内容，装作没看见。")
    if stats["gap_other"] is not None and stats["gap_other"] >= 30:
        y("回复节奏偏慢", f"{other} 的回复中位间隔 {stats['gap_other']} 分钟，可能较忙或聊天优先级不高，注意调整节奏而非抱怨。")
    decline = _find_decline(messages)
    if decline:
        y("邀约被婉拒过", f"你提过「{decline[0]}」，对方回了「{decline[1]}」。不是拒绝你，是场景不对——换个对方本来就感兴趣的场景再约。", f"{decline[0]} / {decline[1]}")
    if relation == "romance":
        comp_q = find_quote(other_msgs, regex=r"有人|同学|朋友.{0,6}(加|聊|追)|加.{0,6}微信")
        if comp_q:
            y("存在竞争者", f"{other} 提到过别人来加好友。处理要大气：不盘问、不贬低，用行动差异化。", comp_q)

    red = [{"title": r} for r in rel["red"]]
    return {"green": green, "yellow": yellow, "red": red}


def _find_decline(messages):
    invite_re = re.compile(r"喝|吃|约|一起|有空|出来|见|去.{0,8}(逛|看|玩)")
    decline_re = re.compile(r"不用|不了|没空|下次|累|戒|减|算了|改天")
    for i, m in enumerate(messages):
        if not _is_me(m) or not re.search(invite_re, m.get("text") or ""):
            continue
        invite = re.sub(r"\s+", " ", m["text"].split("\n", 1)[0])[:24]
        for n in messages[i + 1:i + 5]:
            if not _is_me(n) and re.search(decline_re, n.get("text") or ""):
                return (invite, re.sub(r"\s+", " ", n["text"].split("\n", 1)[0])[:24])
    return None


# ---------------------------------------------------------------- 决策树

def build_tree(messages, stats, relation):
    rel = RELATIONS[relation]
    me, other = rel["me"], rel["other"]
    me_msgs = [m for m in messages if _is_me(m)]
    other_msgs = [m for m in messages if not _is_me(m)]

    stress_q = find_quote(other_msgs, regex=r"压力|累|忙|困|崩溃|烦|焦虑")
    share_q = find_quote(other_msgs, regex=r"刚刚|正在|准备|我在|我去|到家|下课")
    warm_q = find_quote(messages, regex=r"晚安|拍了拍|❤|爱心|想你|开心")
    cur_q = find_quote(other_msgs, regex=r"你呢|怎么|为什么")
    decline = _find_decline(messages)

    if relation == "romance":
        branches = [
            {"n": "1", "color": "#E39D92", "title": f"{other} 主动找你（分享 / 报备）",
             "cond": f"{other} 发来生活碎片、图片或行踪更新。这类消息 = 求陪伴，不是求解决方案。",
             "do": ["先接住 TA 当下的情绪（回应 TA 的此时此刻），再顺着带出新话题",
                    "用 TA 刚用过的词回抛，让话题留在 TA 的世界里",
                    "TA 主动的回合多聊几句再收——主动次数不多，每一次都要接稳"],
             "avoid": ["用「哦 / 嗯 / 哈哈哈」单字终结 TA 的分享", "立刻把话题抢回自己身上", "只回表情包不回内容"],
             "quote": share_q and f"{other} 的原话：{share_q}"},
            {"n": "2", "color": "#8FA8C9", "title": f"我主动开聊",
             "cond": f"想找 {other} 说话时：优先「有信息量的分享」，而不是「在吗 / 在干嘛」。",
             "do": ["用只有你俩懂的梗开场（对话里出现过的暗号）",
                    "逢 TA 的时间节点切入：下课、晚上、周末",
                    "一次只抛 1 个话题，等 TA 接住再抛下一个"],
             "avoid": ["连续审问式提问", "一天多次无内容戳聊", "在 TA 明确忙的时段硬聊"],
             "quote": cur_q and f"TA 会追问你的证据：{cur_q}"},
            {"n": "3", "color": "#D9B25F", "title": "TA 回复变慢 / 冷场了",
             "cond": "30 分钟内没回，或者回复突然变短。",
             "do": ["先默认 TA 在忙，别脑补剧情",
                    "隔 2~4 小时用新话题自然重启，像什么都没发生",
                    "重启句加体谅：「刚下课？」比「你怎么不回我」好一百倍"],
             "avoid": ["「在吗」「怎么不回我」「我是不是说错话了」", "短时间内连续追问", "TA 忙的时候信息轰炸"],
             "quote": f"数据参考：TA 的回复中位间隔 {stats['gap_other'] if stats['gap_other'] is not None else '较长'} 分钟——先对照这个节奏再判断。"},
            {"n": "4", "color": "#C97C6E", "title": "TA 倾诉压力 / 情绪低落",
             "cond": f"{other} 说「累 / 压力 / 崩溃 / 烦」这类话。",
             "do": ["共情放第一：「这也太惨了吧」级别的同频，先别急着给建议",
                    "关怀落到行动：顺手带瓶 TA 爱喝的、点个小外卖，比一百句安慰管用",
                    "TA 的目标和计划：只鼓励、不指导、不追问细节"],
             "avoid": ["说教（「你要早睡」「少玩手机」）", "贩卖焦虑", "提 TA 撤回过的内容"],
             "quote": stress_q and f"{other} 说过：{stress_q}"},
            {"n": "5", "color": "#8FB383", "title": "★ 推进见面（核心分支）",
             "cond": "线上聊得再好也只是热身。邀约原则：选「TA 本来就要做的事」一起做。",
             "do": ["首选 TA 日常高频场景：自习、跑步、常去的食堂——顺路感 > 约会感",
                    "话术框架：「我明晚去 XX，你要是在帮我占个位」",
                    f"{other} 答应 → 提前到、带瓶无糖饮料、用熟悉的话题开场",
                    f"{other} 婉拒 → 大气回应「行，那改天」，退回线上正常聊 2~3 天再换场景"],
             "avoid": ["重复使用被婉拒过的邀约场景", "临时起意式「你现在有空吗」", "拉上朋友搞多人局（要的是单独相处）"],
             "quote": decline and f"注意：你提过「{decline[0]}」被婉拒（{decline[1]}）。换场景，别再提。"},
            {"n": "6", "color": "#B98A9E", "title": "竞争者出现时",
             "cond": f"{other} 提过别人也来加好友 / 接触。",
             "do": ["记住你的差异化优势：真诚、懂 TA、给到情绪价值",
                    "TA 再提起时大气带过：「那哥们勇气可嘉」，不进入比较模式",
                    "把注意力放回主线：谁先落地见面，谁就赢了一半"],
             "avoid": ["盘问（「那人谁啊」「你们聊了啥」）", "贬低对手或自嘲求安慰", "因焦虑加大聊天频率"],
             "quote": "原则：处理竞争者最好的方式，是让 TA 觉得和你的聊天更有意思。"},
            {"n": "7", "color": "#E39D92", "title": "暧昧升温节点（顺势加码）",
             "cond": "拍一拍、昵称、深夜聊天、互相分享歌单——这些节点出现时，顺着加码。",
             "do": ["在共同兴趣上加码：分享一首「你猜我会喜欢你哪首」制造互动",
                    "昵称加码：给 TA 一个只有你用的称呼",
                    "推拉保持：偶尔晚回 20 分钟，一点不确定性让暧昧更有张力",
                    "赞美具体化：夸细节（TA 的作品 / 审美 / 气质），不夸空话"],
             "avoid": ["关系没到就突然表白", "油腻话术刷屏", "TA 明确在忙时还要求即时回应"],
             "quote": warm_q and f"升温证据：{warm_q}"},
            {"n": "8", "color": "#8FA8C9", "title": "线下见面后（前瞻维护）",
             "cond": "第一次见面结束后，关系进入新的校准期。",
             "do": ["见面当晚自然复盘一句：「今天那个 XX 挺有意思」",
                    "借见面里发生的事延展 2~3 天话题",
                    "第二次邀约间隔 3~5 天，换个场景",
                    "见面 2~3 次后如果 TA 开始主动约你，再考虑把关系说开"],
             "avoid": ["见面后连续 48 小时高密度输出", "把第一次见面搞成正式约会压力局", "见完面就暗示「在一起」"],
             "quote": "前瞻原则：见面是关系的放大器——守住线上的人设，别让紧张毁掉积累。"},
        ]
    elif relation == "friend":
        branches = [
            {"n": "1", "color": "#E39D92", "title": "对方主动分享",
             "cond": "对方发来生活动态 / 趣事 / 求助。",
             "do": ["先回应情绪再延展话题", "主动跟进对方提过的事（上次说的考试/面试/生病）"],
             "avoid": ["单字敷衍", "总把话题扯回自己"],
             "quote": share_q and f"对方说过：{share_q}"},
            {"n": "2", "color": "#8FA8C9", "title": "我找对方聊",
             "cond": "想联系时：有事说事，有梗甩梗，别尬聊。",
             "do": ["分享共同兴趣的新内容（歌/比赛/新番）", "看到对方会喜欢的东西拍照丢过去"],
             "avoid": ["在吗", "每天固定打卡式问候"],
             "quote": None},
            {"n": "3", "color": "#D9B25F", "title": "关系变淡 / 冷场",
             "cond": "回复变慢、话题枯竭。",
             "do": ["用「上次你说的那事后来怎么样了」重启，显示你记得", "制造共同经历：约一场比赛/电影/新店"],
             "avoid": ["质问「你最近怎么不理我」", "硬撑无营养的日常播报"],
             "quote": None},
            {"n": "4", "color": "#C97C6E", "title": "对方情绪低落",
             "cond": "对方倾诉烦恼 / 失意。",
             "do": ["倾听为主，肯定情绪：「换我我也难受」", "提供具体帮助选项（陪吃饭/帮看简历/一起吐槽）"],
             "avoid": ["讲大道理", "「我早说过」式补刀"],
             "quote": stress_q and f"对方说过：{stress_q}"},
            {"n": "5", "color": "#8FB383", "title": "★ 约线下聚（核心分支）",
             "cond": "线上聊得不错，就该落地见面。",
             "do": ["借共同兴趣约：新开的店/球局/展/电影", "给出具体时间选项而不是开放式「有空约」"],
             "avoid": ["临时起意", "总让对方组织"],
             "quote": None},
            {"n": "6", "color": "#B98A9E", "title": "对方有事求助",
             "cond": "对方开口借钱 / 求介绍 / 求帮忙。",
             "do": ["能帮就帮到点子上，帮不了给替代方案", "帮忙后不挂在嘴边"],
             "avoid": ["超出能力硬扛", "帮忙时摆出施恩姿态"],
             "quote": None},
            {"n": "7", "color": "#E39D92", "title": "关系升温节点",
             "cond": "对方开始和你分享秘密 / 拉你进圈。",
             "do": ["保守对方的秘密，这是信任存款", "用同样的深度回应（交换一件自己的事）"],
             "avoid": ["把对方的秘密当谈资"],
             "quote": warm_q and f"升温证据：{warm_q}"},
            {"n": "8", "color": "#8FA8C9", "title": "聚会后维护",
             "cond": "见面结束后。",
             "do": ["当天发一条复盘（照片/趣事）", "把见面聊到的事落实（说好推荐的歌就发）"],
             "avoid": ["见完就消失", "每次见面都要对方主动提"],
             "quote": None},
        ]
    elif relation == "work":
        branches = [
            {"n": "1", "color": "#E39D92", "title": "对方主动找你",
             "cond": "对方发来需求 / 问题 / 确认。",
             "do": ["15 分钟内响应，先确认收到再处理", "给出明确的时间预期：「今天 18 点前回复方案」"],
             "avoid": ["已读不回", "答应模糊的时间"],
             "quote": None},
            {"n": "2", "color": "#8FA8C9", "title": "我联系对方",
             "cond": "推进业务 / 同步进度。",
             "do": ["一次说清：背景 + 需求 + 期望时间", "文字为主，关键节点电话跟进"],
             "avoid": ["60 秒长语音", "碎片化连续轰炸"],
             "quote": None},
            {"n": "3", "color": "#D9B25F", "title": "对方迟迟不回",
             "cond": "超过预期时间没反馈。",
             "do": ["隔天轻推一次：「XX 方案您看方便吗，需要我调整随时说」", "换渠道（邮件/电话）"],
             "avoid": ["连环追问", "上情绪（「您是不是不想合作了」）"],
             "quote": None},
            {"n": "4", "color": "#C97C6E", "title": "对方不满 / 有异议",
             "cond": "投诉、质疑、要求改。",
             "do": ["先认账再解释：「这块确实是我考虑不周，马上补」", "给出补救动作和时间"],
             "avoid": ["推卸责任", "和客户争对错"],
             "quote": None},
            {"n": "5", "color": "#8FB383", "title": "★ 推进成交（核心分支）",
             "cond": "需求已明、方案已过，就差临门一脚。",
             "do": ["给选择题不是判断题：「A 方案还是 B 方案？」", "制造合理的时间锚点（排期/名额/优惠）"],
             "avoid": ["逼单式三连", "报价后自己先松口降价"],
             "quote": None},
            {"n": "6", "color": "#B98A9E", "title": "出现比价 / 竞争者",
             "cond": "对方提到别家方案 / 价格。",
             "do": ["不贬低对手，客观对比差异", "强调服务/响应/风险兜底等非价格价值"],
             "avoid": ["竞品攻击", "立刻无条件降价（会显得之前报价没诚意）"],
             "quote": None},
            {"n": "7", "color": "#E39D92", "title": "关系升温节点",
             "cond": "对方开始聊业务之外的事（家庭/爱好）。",
             "do": ["记住对方提过的私事（孩子/爱好），下次自然接上", "适当回应自己的同类信息，对等交换"],
             "avoid": ["过度殷勤", "打探隐私"],
             "quote": None},
            {"n": "8", "color": "#8FA8C9", "title": "合作达成后维护",
             "cond": "签约 / 交付完成。",
             "do": ["定期回访使用情况", "节日轻问候 + 行业信息分享"],
             "avoid": ["交付完就消失（转介绍就没了）", "每逢联系必有新推销"],
             "quote": None},
        ]
    else:  # family
        branches = [
            {"n": "1", "color": "#E39D92", "title": "家人主动联系你",
             "cond": "家人发来问候 / 关心 / 家常。",
             "do": ["当天回，哪怕一句「在忙，晚上视频」", "追问具体细节（「今天做了什么」比「嗯」强百倍）"],
             "avoid": ["隔天才回", "只回「嗯」「哦」「知道」"],
             "quote": share_q and f"家人说过：{share_q}"},
            {"n": "2", "color": "#8FA8C9", "title": "我主动问候",
             "cond": "想起家人时。",
             "do": ["分享自己的生活照片（吃饭/上课/工作），家人要的是画面感", "固定频率：每周至少一次语音/视频"],
             "avoid": ["只在缺钱时出现"],
             "quote": None},
            {"n": "3", "color": "#D9B25F", "title": "联系变少 / 冷场",
             "cond": "很久没说话，不知道聊什么。",
             "do": ["用一张今天的照片开启话题", "问家里的近况：老人身体/猫狗/邻居"],
             "avoid": ["觉得尴尬就不联系", "报喜不报忧到失联"],
             "quote": None},
            {"n": "4", "color": "#C97C6E", "title": "家人担心 / 念叨你",
             "cond": "催起床/吃饭/结婚/回家。",
             "do": ["先接情绪：「知道你们担心我」，再讲你的安排", "用具体行动反馈（晒按时吃饭的照片）"],
             "avoid": ["顶嘴「你们不懂」", "敷衍应承然后照旧"],
             "quote": stress_q and f"家人说过：{stress_q}"},
            {"n": "5", "color": "#8FB383", "title": "★ 想加深陪伴（核心分支）",
             "cond": "想为家人多做一点。",
             "do": ["回家时全身心陪伴：放下手机的那两个小时比礼物珍贵", "教家人用新事物（视频通话/线上买菜），耐心翻倍"],
             "avoid": ["人在心不在", "用红包代替交流"],
             "quote": None},
            {"n": "6", "color": "#B98A9E", "title": "代际分歧",
             "cond": "观念冲突：工作/婚恋/花钱。",
             "do": ["先听完，复述对方的担心（「你们是怕我……」），再表达自己", "用「我最近在考虑……」代替「你们别管我」"],
             "avoid": ["硬杠对错", "冷战式不联系"],
             "quote": None},
            {"n": "7", "color": "#E39D92", "title": "温情时刻",
             "cond": "家人说了暖心的话 / 寄了东西。",
             "do": ["郑重表达感谢，不把家人的好当理所当然", "拍一张「收到」的照片发回去"],
             "avoid": ["一句「知道了」带过"],
             "quote": warm_q and f"温情证据：{warm_q}"},
            {"n": "8", "color": "#8FA8C9", "title": "长期维护",
             "cond": "日常相处。",
             "do": ["把家人的生日/体检日期记进日历", "出差/旅行报平安"],
             "avoid": ["把最坏的脾气留给最亲的人"],
             "quote": None},
        ]
    return branches


# ---------------------------------------------------------------- 时间轴

def build_timeline(relation):
    if relation == "romance":
        return [
            {"phase": "阶段一 · 本周", "title": "降一点热度，稳住节奏",
             "body": "消息占比往 50~55% 收：少发无内容的戳聊，多分享有信息量的日常（图片/趣事/音乐）。既保持存在感，又不显得粘人。"},
            {"phase": "阶段二 · 未来两周", "title": "保温 + 埋下见面伏笔",
             "body": "交换生活碎片，用 TA 感兴趣的话题维持热度。顺口提一次「改天一起去 XX」——先让 TA 有心理预期，不强约。"},
            {"phase": "阶段三 · 落地邀约", "title": "约一个「TA 本来就要做的事」",
             "body": "首选 TA 的高频场景（自习/跑步/常去的地方），用「顺路/顺便」框架提出。被婉拒就换场景，见决策树 ⑤ 号分支。"},
            {"phase": "阶段四 · 见面后", "title": "以见面为契机二次升温",
             "body": "见面当晚自然复盘，借见面事件延展话题。第二次邀约间隔 3~5 天。若 TA 开始主动约你，再考虑把关系说开。"},
        ]
    if relation == "friend":
        return [
            {"phase": "阶段一 · 本周", "title": "恢复日常互动",
             "body": "用共同兴趣重启聊天（新歌/比赛/梗图），保持每周 1~2 次有质量的互动。"},
            {"phase": "阶段二 · 未来两周", "title": "制造共同经历",
             "body": "约一次线下：球局/新店/展/电影。共同经历是友情最扎实的锚点。"},
            {"phase": "阶段三 · 落地邀约", "title": "给出具体选项",
             "body": "「这周末 A 还是 B？」式的具体邀约，比「有空聚」成功率高一倍。"},
            {"phase": "阶段四 · 长期维护", "title": "记住对方的事",
             "body": "对方提过的考试/面试/家人生日，主动跟进一句——被记住的感觉就是友情的温度。"},
        ]
    if relation == "work":
        return [
            {"phase": "阶段一 · 本周", "title": "对齐当前节点",
             "body": "把所有进行中的事项列清单，逐条和对方确认状态与下一步，避免「以为推进了其实没动」。"},
            {"phase": "阶段二 · 未来两周", "title": "推进关键事项",
             "body": "每个节点给出明确的交付时间和责任人。响应保持在 15 分钟内，兑现每一个承诺。"},
            {"phase": "阶段三 · 落地成交", "title": "给选择题，制造时间锚点",
             "body": "用「A 方案还是 B 方案」推进决策，配合排期/名额等合理锚点，不逼单。"},
            {"phase": "阶段四 · 长期维护", "title": "定期回访 + 轻问候",
             "body": "交付后回访使用情况；节日轻问候；每次联系带一点对方用得到的信息。"},
        ]
    return [
        {"phase": "阶段一 · 本周", "title": "先恢复频率",
        "body": "从今天开始每天或隔天联系一次：一张照片、一句问候都行，重点是让家人习惯你的存在。"},
        {"phase": "阶段二 · 未来两周", "title": "把关心具体化",
        "body": "把「注意身体」换成具体行动：寄点东西、视频教用新功能、约好回家的日期。"},
        {"phase": "阶段三 · 落地陪伴", "title": "回家 / 见面",
        "body": "安排一次回家或长视频。陪伴的质量 = 放下手机的那几个小时。"},
        {"phase": "阶段四 · 长期维护", "title": "固定节奏",
        "body": "每周至少一次语音，节日和生日有表示。家人要的不多，是有规律的惦记。"},
    ]


# ---------------------------------------------------------------- 解读

def build_insight(stats, relation, chat_name):
    rel = RELATIONS[relation]
    me, other = rel["me"], rel["other"]
    pts = []
    pts.append(
        f"在 {stats['days']} 天里，你们交换了 {stats['total']} 条消息：你 {stats['me_n']} 条（{stats['me_ratio']}%），"
        f"{other} {stats['other_n']} 条（{round(100 - stats['me_ratio'], 1)}%）。"
    )
    if stats["night_ratio"] >= 20:
        pts.append(
            f"深夜（22 点后）消息占 {stats['night_ratio']}%——这个时段人最放松、也最真实，"
            "能在这个时段稳定聊下去，说明彼此愿意把「不设防的时间」留给对方。"
        )
    else:
        pts.append("聊天集中在白天时段，深夜交流不多。如果想让关系更深，可以试着在晚间聊一两个更软的话题。")
    if stats["gap_other"] is not None:
        pts.append(
            f"{other} 的回复中位间隔 {stats['gap_other']} 分钟" +
            ("，是「即问即答」的热聊状态。" if stats["gap_other"] <= 5 else "，节奏偏从容。对照这个基线判断「慢回」是忙还是冷。")
        )
    if stats["init_other"] > 0:
        pts.append(f"{other} 主动开聊 {stats['init_other']} 次，你不是单方面拉动，这是关系健康的关键信号。")
    else:
        pts.append(f"这段时间的对话几乎都由你先开口。试着制造一些「钩子」（分享到一半留悬念），把主动的位置分给 {other} 一些。")
    if relation == "romance":
        pts.append("暧昧期的核心目标不是聊得更多，而是「把线上的热落成线下的见面」——见决策树 ⑤ 号分支。")
    elif relation == "work":
        pts.append("职场对话的质量看两件事：响应的速度和兑现承诺的密度。把每个「回头再说」都变成「什么时候、谁来做」。")
    elif relation == "family":
        pts.append("对家人来说，「被记得」比「被需要」更重要。频率比内容重要，具体比客气重要。")
    return pts


# ---------------------------------------------------------------- 汇总

def analyze(messages, relation="romance", chat_name="", meta=None):
    if relation not in RELATIONS:
        relation = "romance"
    stats = compute_stats(messages)
    if not stats:
        raise RuntimeError("没有可分析的消息（时间范围内无记录）")
    return {
        "meta": dict(meta or {}, chat=chat_name, relation=relation,
                     relation_label=RELATIONS[relation]["label"],
                     generated_at=datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
        "stats": stats,
        "topics": compute_topics(messages, relation),
        "signals": detect_signals(messages, stats, relation),
        "tree": build_tree(messages, stats, relation),
        "timeline": build_timeline(relation),
        "insight": build_insight(stats, relation, chat_name),
    }


# ---------------------------------------------------------------- 报告渲染

REPORT_CSS = """
:root{--bg:#FAF6F1;--card:#FFF;--ink:#5A463C;--muted:#A08C7F;--line:#EFE3D9;
--pink:#F3C6BE;--pink-deep:#E39D92;--blue:#C6D8EC;--blue-deep:#8FA8C9;--green:#C4D8BC;
--green-deep:#8FB383;--yellow:#F5DFAE;--yellow-deep:#D9B25F;--red-deep:#C97C6E;
--radius:22px;--shadow:0 10px 30px rgba(190,150,120,.12),0 2px 6px rgba(190,150,120,.06)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;background:
radial-gradient(1200px 500px at 85% -10%,rgba(243,198,190,.35),transparent 60%),
radial-gradient(900px 500px at -10% 20%,rgba(198,216,236,.3),transparent 60%),var(--bg);
color:var(--ink);line-height:1.75;min-height:100vh}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
.hero{background:linear-gradient(135deg,#FFFDFB,#FDEFEA 55%,#F6E4EE);border:1px solid #F6E0D8;
border-radius:34px;padding:48px 44px 40px;box-shadow:var(--shadow);margin-bottom:40px}
.hero h1{font-size:32px;font-weight:700;letter-spacing:1px;background:linear-gradient(120deg,#8A6B5B,#C97C6E 60%,#B98A9E);
-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{margin-top:12px;color:#8A7666;font-size:14.5px}
.hero .chip{display:inline-block;font-size:12.5px;padding:5px 13px;border-radius:999px;
background:rgba(255,255,255,.75);border:1px solid var(--line);color:#7E6A5C;margin:0 8px 8px 0}
section{margin-top:40px}
h2{font-size:20px;font-weight:700;color:#6B5346;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:26px 28px;box-shadow:var(--shadow)}
.card+.card{margin-top:14px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow)}
.stat b{font-size:24px;display:block}
.stat span{font-size:12.5px;color:var(--muted)}
.pink b{color:var(--pink-deep)}.blue b{color:var(--blue-deep)}.green b{color:var(--green-deep)}.yellow b{color:var(--yellow-deep)}
.signal{border-radius:var(--radius);padding:22px 24px;border:1px solid var(--line);background:var(--card)}
.signal h3{font-size:15.5px;margin-bottom:12px}
.signal ul{list-style:none}
.signal li{padding:7px 0 7px 18px;position:relative;font-size:13.5px;color:#6E5B4E;border-bottom:1px dashed var(--line)}
.signal li:last-child{border-bottom:none}
.signal li::before{content:"";position:absolute;left:2px;top:15px;width:7px;height:7px;border-radius:50%}
.signal.green h3{color:#5E8A57}.signal.green li::before{background:var(--green-deep)}
.signal.yellow h3{color:#A98A3C}.signal.yellow li::before{background:var(--yellow-deep)}
.signal.red h3{color:#B05F52}.signal.red li::before{background:var(--red-deep)}
.q{color:#B49C8C;font-size:12.5px}
.branch{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px}
.branch summary{list-style:none;cursor:pointer;padding:16px 20px;display:flex;align-items:center;gap:12px}
.branch summary::-webkit-details-marker{display:none}
.branch .n{width:30px;height:30px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;flex:none}
.branch h4{font-size:15px;font-weight:700;flex:1}
.branch .caret{width:24px;height:24px;border-radius:50%;background:#F7EEE7;color:#B49C8C;display:flex;align-items:center;justify-content:center;font-size:12px;transition:transform .3s}
.branch[open] .caret{transform:rotate(180deg)}
.branch .body{padding:4px 20px 18px}
.node{border-radius:14px;padding:12px 15px;font-size:13px;margin:8px 0;border:1px solid var(--line)}
.node.cond{background:#F4F8F3;border-color:#DDE9D7}
.node.do{background:#F2F7F4;border-color:#D9E8D6}
.node.avoid{background:#FCF1EE;border-color:#F3D8CF}
.node .k{display:inline-block;font-size:11px;font-weight:700;letter-spacing:1px;border-radius:6px;padding:2px 8px;margin-right:8px;color:#fff}
.node.cond .k{background:#A8BCA2}.node.do .k{background:var(--green-deep)}.node.avoid .k{background:var(--red-deep)}
.node li{list-style:none;padding:2px 0 2px 14px;position:relative}
.node li::before{content:"·";position:absolute;left:3px;color:var(--muted);font-weight:700}
.quote{font-size:12px;color:#B49C8C;text-align:center;margin-top:6px}
.t-item{padding:12px 0 12px 26px;border-left:2px solid var(--pink);margin-left:8px;position:relative}
.t-item::before{content:"";position:absolute;left:-8px;top:20px;width:12px;height:12px;border-radius:50%;background:#fff;border:3px solid var(--pink-deep)}
.t-time{font-size:12px;color:var(--muted);letter-spacing:1px}
.t-item h4{font-size:14.5px;font-weight:700;margin:2px 0}
.t-item p{font-size:13px;color:#7A6557}
footer{margin-top:50px;text-align:center;font-size:12px;color:#B49C8C}
"""


def render_report(pkg):
    s = pkg["stats"]
    m = pkg["meta"]
    signals = pkg["signals"]
    rel = RELATIONS[m["relation"]]
    me, other = rel["me"], rel["other"]

    stats_cards = "".join([
        f'<div class="stat pink"><b>{s["total"]}</b><span>有效消息总数（{s["days"]} 天）</span></div>',
        f'<div class="stat blue"><b>{s["night_ratio"]}%</b><span>深夜（22 点后）聊天占比</span></div>',
        f'<div class="stat green"><b>{s["gap_other"] if s["gap_other"] is not None else "-"} 分钟</b><span>{other} 的回复中位间隔</span></div>',
        f'<div class="stat yellow"><b>{s["me_ratio"]}% : {100 - s["me_ratio"]}%</b><span>{me} : {other} 消息占比</span></div>',
        f'<div class="stat pink"><b>{s["init_me"]} : {s["init_other"]}</b><span>主动开聊次数（{me} : {other}）</span></div>',
        f'<div class="stat blue"><b>{s["voice_other"]} 条</b><span>{other} 发的语音</span></div>',
    ])

    def sig_html(items, cls):
        lis = "".join(
            f'<li><b>{html.escape(i.get("title", ""))}</b>：{html.escape(i.get("detail", ""))}'
            + (f' <span class="q">（{html.escape(i["quote"])}）</span>' if i.get("quote") else "")
            + "</li>"
            for i in items)
        return f'<div class="signal {cls}"><h3>{len(items)} 条</h3><ul>{lis or "<li>暂无</li>"}</ul></div>'

    tree_html = ""
    for i, b in enumerate(pkg["tree"]):
        open_attr = " open" if b["n"] == "5" else ""
        tree_html += f"""
<div class="branch"{open_attr}>
<summary><span class="n" style="background:{b['color']}">{b["n"]}</span><h4>{html.escape(b["title"])}</h4><span class="caret">▾</span></summary>
<div class="body">
<div class="node cond"><span class="k">判断</span>{html.escape(b["cond"])}</div>
<div class="node do"><span class="k">行动</span><ul>{''.join(f'<li>{html.escape(x)}</li>' for x in b['do'])}</ul></div>
<div class="node avoid"><span class="k">禁忌</span><ul>{''.join(f'<li>{html.escape(x)}</li>' for x in b['avoid'])}</ul></div>
{('<p class="quote">' + html.escape(b["quote"]) + '</p>') if b.get("quote") else ''}
</div></div>"""

    timeline_html = "".join(
        f'<div class="t-item"><div class="t-time">{html.escape(t["phase"])}</div>'
        f'<h4>{html.escape(t["title"])}</h4><p>{html.escape(t["body"])}</p></div>'
        for t in pkg["timeline"])

    insight_html = "".join(f"<p style='margin:8px 0;font-size:13.5px;color:#7A6557'>• {html.escape(p)}</p>" for p in pkg["insight"])

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{html.escape(m['chat'])} · 聊天复盘与策略决策树</title>
<style>{REPORT_CSS}</style></head><body><div class="wrap">
<div class="hero">
<span class="chip">对象：<b>{html.escape(m['chat'])}</b></span>
<span class="chip">关系定位：<b>{m['relation_label']}</b></span>
<span class="chip">时间段：<b>{s['first_ts']} ~ {s['last_ts']}</b></span>
<span class="chip">记录条数：<b>{s['total']} 条</b></span>
<h1>聊天复盘 · 策略决策树</h1>
<p>{html.escape(pkg['insight'][0]) if pkg['insight'] else ''}</p>
<p style="font-size:12px;color:#B49C8C;margin-top:10px">🔒 本报告由「微信聊天分析站」在本机生成，数据未上传任何地方，请勿外传。</p>
</div>
<section><h2>① 关系速览</h2><div class="grid">{stats_cards}</div></section>
<section><h2>② 核心解读</h2><div class="card">{insight_html}</div></section>
<section><h2>③ 信号灯</h2>
<div class="card">{sig_html(signals['green'], 'green')}
<div style="margin-top:12px">{sig_html(signals['yellow'], 'yellow')}</div>
<div style="margin-top:12px">{sig_html(signals['red'], 'red')}</div></div></section>
<section><h2>④ 策略决策树</h2>{tree_html}</section>
<section><h2>⑤ 推进时间轴</h2><div class="card">{timeline_html}</div></section>
<footer>由「微信聊天分析站」本地生成 · {m['generated_at']}</footer>
</div></body></html>"""
