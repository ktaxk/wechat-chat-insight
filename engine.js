/* 微信聊天分析站 · 分析引擎（纯前端版，与 local/analysis.py 逻辑一致）
 * 输入: messages = [{ts, time, sender:"me"|"other", type, type_label, text}]
 * 输出: {meta, stats, topics, signals, tree, timeline, insight}
 */
"use strict";

const Engine = (() => {

  // ---------------- 基础工具 ----------------
  const median = (vals) => {
    if (!vals.length) return null;
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isMe = (m) => m.sender === "me";
  const hasCjk = (t) => /[\u4e00-\u9fff]/.test(t || "");

  function findQuote(messages, sender, regex, maxLen = 60) {
    for (const m of messages) {
      if (sender !== null && m.sender !== sender) continue;
      let t = (m.text || "").trim();
      if (!t || t.startsWith("[")) continue;
      t = t.split("\n", 1)[0].trim();
      if (!hasCjk(t)) continue;
      if (regex && !regex.test(t)) continue;
      t = t.replace(/\s+/g, " ");
      return t.length > maxLen ? t.slice(0, maxLen) + "…" : t;
    }
    return null;
  }

  // ---------------- 关系类型配置 ----------------
  const RELATIONS = {
    romance: {
      label: "暧昧/恋爱对象", me: "你", other: "TA",
      topics: {
        "日常分享": ["吃", "饭", "食堂", "外卖", "奶茶", "咖啡", "喝", "零食"],
        "兴趣爱好": ["音乐", "歌", "游戏", "电影", "剧", "综艺", "书", "乐队", "番"],
        "学习工作": ["课", "作业", "考试", "复习", "实验", "上班", "加班", "项目", "自习"],
        "生活校园": ["宿舍", "寝室", "学校", "教室", "食堂", "操场", "校园"],
        "情绪压力": ["累", "压力", "忙", "困", "崩溃", "烦", "焦虑", "难"],
        "暧昧升温": ["晚安", "早安", "想你", "抱抱", "爱心", "❤", "喜欢", "拍", "学长", "学妹"],
      },
      red: [
        "别在还没线下相处时突然表白——把暧昧期的主动权一次押光。",
        "别追问 TA 撤回的内容，装没看见，安全感比好奇心值钱。",
        "别审问式聊天（连续抛问题），聊天不是面试。",
        "别重复使用被婉拒过的邀约场景，换一个再约。",
        "别吃醋式盘问其他追求者，大气和自信才是降维打击。",
        "别在 TA 明确说忙（上课/加班）时要求即时回应。",
      ],
    },
    friend: {
      label: "朋友/同学", me: "你", other: "对方",
      topics: {
        "日常分享": ["吃", "饭", "玩", "出去", "聚", "逛街", "打球"],
        "兴趣爱好": ["游戏", "音乐", "电影", "剧", "动漫", "球", "健身", "综艺"],
        "学习工作": ["课", "作业", "考试", "实习", "工作", "面试", "考研"],
        "吐槽调侃": ["哈哈", "笑死", "绷", "离谱", "服了", "绝了", "牛"],
        "情绪倾诉": ["累", "烦", "压力", "难过", "伤心", "失恋", "崩溃"],
        "互相帮助": ["帮", "借", "问一下", "麻烦", "谢谢", "感谢"],
      },
      red: [
        "别只在有求于对方时才出现——平时不维系，用时方恨少。",
        "别把对方的倾诉当玩笑，朋友也会记仇。",
        "别单方面倾倒负能量，长期单向输出会耗光耐心。",
        "别拿对方的糗事在公开场合反复调侃。",
        "别爽约——朋友关系的信用账户很容易透支。",
      ],
    },
    work: {
      label: "职场/客户", me: "你", other: "对方",
      topics: {
        "需求推进": ["需求", "方案", "报价", "合同", "付款", "交付", "验收", "排期"],
        "业务沟通": ["项目", "产品", "会议", "邮件", "报告", "数据", "对接"],
        "关系维护": ["吃饭", "喝茶", "咖啡", "活动", "参观", "聊"],
        "问题处理": ["问题", "bug", "故障", "延期", "投诉", "改", "急"],
        "寒暄问候": ["节日", "周末", "假期", "天气", "家人", "身体"],
      },
      red: [
        "别发 60 秒长语音轰炸——职场沟通文字优先。",
        "别把个人情绪带进商务对话。",
        "别轻易承诺做不到的交付时间，信任成本极高。",
        "别越过对方的工作边界（跳过对接人直接找上级）。",
        "别在对方明确下班/休假时持续推业务。",
      ],
    },
    family: {
      label: "家人/长辈", me: "你", other: "对方",
      topics: {
        "日常问候": ["吃", "睡", "身体", "注意", "天气", "降温", "穿"],
        "生活近况": ["学校", "工作", "学习", "考试", "忙", "累"],
        "家常事务": ["家里", "爸妈", "奶奶", "爷爷", "亲戚", "回家"],
        "关心叮嘱": ["注意", "小心", "照顾", "别熬", "多吃"],
        "倾诉回忆": ["以前", "小时候", "当年", "想"],
      },
      red: [
        "别对关心敷衍了事——「嗯」「哦」是家人关系最大的冷暴力。",
        "别只在缺钱/有事时才想起联系。",
        "别和长辈硬杠对错，先接住情绪再谈道理。",
        "别报忧不报喜太久，家人会一直悬着心。",
        "别把最坏的脾气留给最亲的人。",
      ],
    },
  };

  // ---------------- 统计 ----------------
  function computeStats(messages) {
    const msgs = messages.filter(m => m.ts);
    if (!msgs.length) return null;
    const total = msgs.length;
    const meN = msgs.filter(isMe).length;
    const otherN = total - meN;

    const daily = {}, dailyMe = {}, dailyOther = {};
    const hours = new Array(24).fill(0), hoursMe = new Array(24).fill(0), hoursOther = new Array(24).fill(0);
    const types = {}, typesMe = {}, typesOther = {};
    let night = 0;
    for (const m of msgs) {
      const dt = new Date(m.ts * 1000);
      const k = String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
      daily[k] = (daily[k] || 0) + 1;
      hours[dt.getHours()]++;
      const t = m.type_label || "其他";
      if (isMe(m)) {
        dailyMe[k] = (dailyMe[k] || 0) + 1;
        hoursMe[dt.getHours()]++;
        typesMe[t] = (typesMe[t] || 0) + 1;
      } else {
        dailyOther[k] = (dailyOther[k] || 0) + 1;
        hoursOther[dt.getHours()]++;
        typesOther[t] = (typesOther[t] || 0) + 1;
      }
      types[t] = (types[t] || 0) + 1;
      if (dt.getHours() >= 22 || dt.getHours() < 2) night++;
    }

    const gaps = (sender) => {
      const seq = msgs.filter(m => m.sender === sender).map(m => m.ts);
      const g = [];
      for (let i = 1; i < seq.length; i++) {
        const dmin = (seq[i] - seq[i - 1]) / 60;
        if (dmin > 0.2 && dmin < 600) g.push(dmin);
      }
      return g;
    };
    const initiations = (sender) => {
      let cnt = 0, prev = null;
      for (const m of msgs) {
        if (prev === null || (m.ts - prev) / 60 > 60) {
          if (m.sender === sender) cnt++;
        }
        prev = m.ts;
      }
      return cnt;
    };

    const gMe = gaps("me"), gOther = gaps("other");
    return {
      first_ts: msgs[0].time, last_ts: msgs[msgs.length - 1].time,
      days: Math.max(1, Math.floor((msgs[msgs.length - 1].ts - msgs[0].ts) / 86400) + 1),
      total, me_n: meN, other_n: otherN,
      me_ratio: total ? Math.round(meN / total * 1000) / 10 : 0,
      daily: Object.fromEntries(Object.entries(daily).sort()),
      daily_me: Object.fromEntries(Object.entries(dailyMe).sort()),
      daily_other: Object.fromEntries(Object.entries(dailyOther).sort()),
      hours, hours_me: hoursMe, hours_other: hoursOther,
      night_ratio: total ? Math.round(night / total * 1000) / 10 : 0,
      gap_me: median(gMe) == null ? null : Math.round(median(gMe) * 100) / 100,
      gap_other: median(gOther) == null ? null : Math.round(median(gOther) * 100) / 100,
      init_me: initiations("me"), init_other: initiations("other"),
      types: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1])),
      types_me: Object.fromEntries(Object.entries(typesMe).sort((a, b) => b[1] - a[1])),
      types_other: Object.fromEntries(Object.entries(typesOther).sort((a, b) => b[1] - a[1])),
      voice_me: typesMe["语音"] || 0, voice_other: typesOther["语音"] || 0,
      sticker_me: typesMe["表情"] || 0, sticker_other: typesOther["表情"] || 0,
      revoke: types["撤回"] || 0,
    };
  }

  function computeTopics(messages, relation) {
    const kws = RELATIONS[relation].topics;
    const counts = {};
    for (const m of messages) {
      const t = m.text || "";
      for (const [topic, words] of Object.entries(kws)) {
        if (words.some(w => t.includes(w))) counts[topic] = (counts[topic] || 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  }

  // ---------------- 信号检测 ----------------
  function detectSignals(messages, stats, relation) {
    const meMsgs = messages.filter(isMe);
    const otherMsgs = messages.filter(m => !isMe(m));
    const rel = RELATIONS[relation];
    const me = rel.me, other = rel.other;
    const green = [], yellow = [];
    const g = (title, detail, quote) => { const it = { title, detail }; if (quote) it.quote = quote; green.push(it); };
    const y = (title, detail, quote) => { const it = { title, detail }; if (quote) it.quote = quote; yellow.push(it); };

    if (stats.night_ratio >= 20)
      g("深夜陪伴", `22 点后的聊天占 ${stats.night_ratio}%，愿意把睡前的私人时间留给你，是关系深度的重要指标。`);
    if (stats.gap_other !== null && stats.gap_other <= 2)
      g("热聊节奏", `${other} 回复你的中位间隔只有 ${stats.gap_other} 分钟，聊天状态是「即问即答」。`);
    if (stats.voice_other > 0)
      g("语音消息", `${other} 发过 ${stats.voice_other} 条语音。愿意开口说话，比打字更进一步。`);
    const shareQ = findQuote(otherMsgs, null, /刚刚|正在|正准备|我去|我先|到家|在图书馆|在教室|下课|去上课|回来/);
    if (shareQ) g("主动报备", `${other} 会主动向你同步行踪和生活动态，这是信任和「想让你知道」的信号。`, shareQ);
    const curQ = findQuote(otherMsgs, null, /你呢|怎么|为什么|啥/);
    if (curQ) g("双向好奇", `${other} 不只是回答问题，也会反过来追问你——单方面的聊天走不远。`, curQ);
    if (stats.init_other >= 2) g("主动开聊", `这段时间 ${other} 主动挑起新话题 ${stats.init_other} 次，关系不是单方拉动。`);
    const stressQ = findQuote(otherMsgs, null, /压力|累|忙|困|崩溃|烦|焦虑|难过|难/);
    if (stressQ) g("自我袒露", `${other} 向你袒露过情绪状态，人只会对信任的人示弱。`, stressQ);
    if (stats.revoke >= 3) g("在意形象", `对话中有 ${stats.revoke} 次撤回记录，说明 ${other} 在意在你面前的表达质量。`);

    if (relation === "romance") {
      const patQ = findQuote(messages, null, /拍了拍/);
      if (patQ) g("肢体语言式互动", "拍一拍、亲昵表情这类「小动作」频繁出现，是暧昧升温的典型表现。", patQ);
      const nightQ = findQuote(messages, null, /晚安|早安/);
      if (nightQ) g("早晚问候", "「晚安」不只是礼貌，是给这一天画上句号的仪式感。", nightQ);
    } else if (relation === "friend") {
      if (stats.sticker_other >= stats.total * 0.05)
        g("表情包文化", `${other} 和你斗图 ${stats.sticker_other} 次，玩梗顺畅是关系松弛的证明。`);
      const helpQ = findQuote(otherMsgs, null, /帮|问一下|麻烦|谢谢/);
      if (helpQ) g("互助关系", `${other} 会放心地开口找你帮忙，说明你在他/她心里是「靠得住的人」。`, helpQ);
    } else if (relation === "work") {
      if (stats.gap_other !== null && stats.gap_other <= 30)
        g("响应及时", `${other} 回复中位间隔 ${stats.gap_other} 分钟，合作意愿和优先级都很高。`);
      const bizQ = findQuote(otherMsgs, null, /需求|方案|报价|合同|交付|确认|推进/);
      if (bizQ) g("务实推进", `${other} 主动推进业务话题，比客套话有分量得多。`, bizQ);
    } else if (relation === "family") {
      const careQ = findQuote(otherMsgs, null, /注意|小心|照顾|别熬|多吃|穿|身体|睡/);
      if (careQ) g("关心叮嘱", "长辈式的具体关心，是家人独有的表达方式。", careQ);
      if (stats.init_other >= 1) g("主动联系", `${other} 主动找过你 ${stats.init_other} 次，家人开口前往往已经想你好几天了。`);
    }

    if (stats.me_ratio >= 57 && (relation === "romance" || relation === "friend"))
      y("消息量倒挂", `你占 ${stats.me_ratio}%，${other} 占 ${Math.round((100 - stats.me_ratio) * 10) / 10}%。长期倒挂会稀释吸引力和对方的主动性，试着少说一点、多引对方说。`);
    const depQ = findQuote(meMsgs, null, /抱歉|对不起|冒昧|见笑|打扰|我菜|我真笨/);
    if (depQ) y("自我贬低偏多", "过度谦卑会削弱吸引力，把「抱歉/见笑」换成陈述事实。", depQ);
    if (stats.revoke >= 5) y("撤回频繁", `对话中有 ${stats.revoke} 次撤回。TA 在意你的看法——别追问被撤回的内容，装作没看见。`);
    if (stats.gap_other !== null && stats.gap_other >= 30)
      y("回复节奏偏慢", `${other} 的回复中位间隔 ${stats.gap_other} 分钟，可能较忙或聊天优先级不高，注意调整节奏而非抱怨。`);
    const decline = findDecline(messages);
    if (decline) y("邀约被婉拒过", `你提过「${decline[0]}」，对方回了「${decline[1]}」。不是拒绝你，是场景不对——换个对方本来就感兴趣的场景再约。`, `${decline[0]} / ${decline[1]}`);
    if (relation === "romance") {
      const compQ = findQuote(otherMsgs, null, /有人|同学|朋友.{0,6}(加|聊|追)|加.{0,6}微信/);
      if (compQ) y("存在竞争者", `${other} 提到过别人来加好友。处理要大气：不盘问、不贬低，用行动差异化。`, compQ);
    }

    const red = rel.red.map(r => ({ title: r }));
    return { green, yellow, red };
  }

  function findDecline(messages) {
    const inviteRe = /喝|吃|约|一起|有空|出来|见|去.{0,8}(逛|看|玩)/;
    const declineRe = /不用|不了|没空|下次|累|戒|减|算了|改天/;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!isMe(m) || !inviteRe.test(m.text || "")) continue;
      const invite = m.text.split("\n", 1)[0].replace(/\s+/g, " ").slice(0, 24);
      for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
        const n = messages[j];
        if (!isMe(n) && declineRe.test(n.text || "")) {
          return [invite, n.text.split("\n", 1)[0].replace(/\s+/g, " ").slice(0, 24)];
        }
      }
    }
    return null;
  }

  // ---------------- 决策树 ----------------
  function buildTree(messages, stats, relation) {
    const rel = RELATIONS[relation];
    const me = rel.me, other = rel.other;
    const meMsgs = messages.filter(isMe);
    const otherMsgs = messages.filter(m => !isMe(m));
    const stressQ = findQuote(otherMsgs, null, /压力|累|忙|困|崩溃|烦|焦虑/);
    const shareQ = findQuote(otherMsgs, null, /刚刚|正在|准备|我在|我去|到家|下课/);
    const warmQ = findQuote(messages, null, /晚安|拍了拍|❤|爱心|想你|开心/);
    const curQ = findQuote(otherMsgs, null, /你呢|怎么|为什么/);
    const decline = findDecline(messages);
    const gapTxt = stats.gap_other === null ? "较长" : stats.gap_other;

    if (relation === "romance") return [
      { n: "1", color: "#E39D92", title: `${other} 主动找你（分享 / 报备）`,
        cond: `${other} 发来生活碎片、图片或行踪更新。这类消息 = 求陪伴，不是求解决方案。`,
        do: ["先接住 TA 当下的情绪（回应 TA 的此时此刻），再顺着带出新话题",
          "用 TA 刚用过的词回抛，让话题留在 TA 的世界里",
          "TA 主动的回合多聊几句再收——主动次数不多，每一次都要接稳"],
        avoid: ["用「哦 / 嗯 / 哈哈哈」单字终结 TA 的分享", "立刻把话题抢回自己身上", "只回表情包不回内容"],
        quote: shareQ ? `${other} 的原话：${shareQ}` : null },
      { n: "2", color: "#8FA8C9", title: "我主动开聊",
        cond: `想找 ${other} 说话时：优先「有信息量的分享」，而不是「在吗 / 在干嘛」。`,
        do: ["用只有你俩懂的梗开场（对话里出现过的暗号）", "逢 TA 的时间节点切入：下课、晚上、周末", "一次只抛 1 个话题，等 TA 接住再抛下一个"],
        avoid: ["连续审问式提问", "一天多次无内容戳聊", "在 TA 明确忙的时段硬聊"],
        quote: curQ ? `TA 会追问你的证据：${curQ}` : null },
      { n: "3", color: "#D9B25F", title: "TA 回复变慢 / 冷场了",
        cond: "30 分钟内没回，或者回复突然变短。",
        do: ["先默认 TA 在忙，别脑补剧情", "隔 2~4 小时用新话题自然重启，像什么都没发生", "重启句加体谅：「刚下课？」比「你怎么不回我」好一百倍"],
        avoid: ["「在吗」「怎么不回我」「我是不是说错话了」", "短时间内连续追问", "TA 忙的时候信息轰炸"],
        quote: `数据参考：TA 的回复中位间隔 ${gapTxt} 分钟——先对照这个节奏再判断。` },
      { n: "4", color: "#C97C6E", title: "TA 倾诉压力 / 情绪低落",
        cond: `${other} 说「累 / 压力 / 崩溃 / 烦」这类话。`,
        do: ["共情放第一：「这也太惨了吧」级别的同频，先别急着给建议", "关怀落到行动：顺手带瓶 TA 爱喝的、点个小外卖，比一百句安慰管用", "TA 的目标和计划：只鼓励、不指导、不追问细节"],
        avoid: ["说教（「你要早睡」「少玩手机」）", "贩卖焦虑", "提 TA 撤回过的内容"],
        quote: stressQ ? `${other} 说过：${stressQ}` : null },
      { n: "5", color: "#8FB383", title: "★ 推进见面（核心分支）",
        cond: "线上聊得再好也只是热身。邀约原则：选「TA 本来就要做的事」一起做。",
        do: ["首选 TA 日常高频场景：自习、跑步、常去的食堂——顺路感 > 约会感",
          "话术框架：「我明晚去 XX，你要是在帮我占个位」",
          `${other} 答应 → 提前到、带瓶无糖饮料、用熟悉的话题开场`,
          `${other} 婉拒 → 大气回应「行，那改天」，退回线上正常聊 2~3 天再换场景`],
        avoid: ["重复使用被婉拒过的邀约场景", "临时起意式「你现在有空吗」", "拉上朋友搞多人局（要的是单独相处）"],
        quote: decline ? `注意：你提过「${decline[0]}」被婉拒（${decline[1]}）。换场景，别再提。` : null },
      { n: "6", color: "#B98A9E", title: "竞争者出现时",
        cond: `${other} 提过别人也来加好友 / 接触。`,
        do: ["记住你的差异化优势：真诚、懂 TA、给到情绪价值", "TA 再提起时大气带过：「那哥们勇气可嘉」，不进入比较模式", "把注意力放回主线：谁先落地见面，谁就赢了一半"],
        avoid: ["盘问（「那人谁啊」「你们聊了啥」）", "贬低对手或自嘲求安慰", "因焦虑加大聊天频率"],
        quote: "原则：处理竞争者最好的方式，是让 TA 觉得和你的聊天更有意思。" },
      { n: "7", color: "#E39D92", title: "暧昧升温节点（顺势加码）",
        cond: "拍一拍、昵称、深夜聊天、互相分享歌单——这些节点出现时，顺着加码。",
        do: ["在共同兴趣上加码：分享一首「你猜我会喜欢你哪首」制造互动", "昵称加码：给 TA 一个只有你用的称呼", "推拉保持：偶尔晚回 20 分钟，一点不确定性让暧昧更有张力", "赞美具体化：夸细节（TA 的作品 / 审美 / 气质），不夸空话"],
        avoid: ["关系没到就突然表白", "油腻话术刷屏", "TA 明确在忙时还要求即时回应"],
        quote: warmQ ? `升温证据：${warmQ}` : null },
      { n: "8", color: "#8FA8C9", title: "线下见面后（前瞻维护）",
        cond: "第一次见面结束后，关系进入新的校准期。",
        do: ["见面当晚自然复盘一句：「今天那个 XX 挺有意思」", "借见面里发生的事延展 2~3 天话题", "第二次邀约间隔 3~5 天，换个场景", "见面 2~3 次后如果 TA 开始主动约你，再考虑把关系说开"],
        avoid: ["见面后连续 48 小时高密度输出", "把第一次见面搞成正式约会压力局", "见完面就暗示「在一起」"],
        quote: "前瞻原则：见面是关系的放大器——守住线上的人设，别让紧张毁掉积累。" },
    ];
    if (relation === "friend") return [
      { n: "1", color: "#E39D92", title: "对方主动分享", cond: "对方发来生活动态 / 趣事 / 求助。",
        do: ["先回应情绪再延展话题", "主动跟进对方提过的事（上次说的考试/面试/生病）"],
        avoid: ["单字敷衍", "总把话题扯回自己"], quote: shareQ ? `对方说过：${shareQ}` : null },
      { n: "2", color: "#8FA8C9", title: "我找对方聊", cond: "想联系时：有事说事，有梗甩梗，别尬聊。",
        do: ["分享共同兴趣的新内容（歌/比赛/新番）", "看到对方会喜欢的东西拍照丢过去"],
        avoid: ["在吗", "每天固定打卡式问候"], quote: null },
      { n: "3", color: "#D9B25F", title: "关系变淡 / 冷场", cond: "回复变慢、话题枯竭。",
        do: ["用「上次你说的那事后来怎么样了」重启，显示你记得", "制造共同经历：约一场比赛/电影/新店"],
        avoid: ["质问「你最近怎么不理我」", "硬撑无营养的日常播报"], quote: null },
      { n: "4", color: "#C97C6E", title: "对方情绪低落", cond: "对方倾诉烦恼 / 失意。",
        do: ["倾听为主，肯定情绪：「换我我也难受」", "提供具体帮助选项（陪吃饭/帮看简历/一起吐槽）"],
        avoid: ["讲大道理", "「我早说过」式补刀"], quote: stressQ ? `对方说过：${stressQ}` : null },
      { n: "5", color: "#8FB383", title: "★ 约线下聚（核心分支）", cond: "线上聊得不错，就该落地见面。",
        do: ["借共同兴趣约：新开的店/球局/展/电影", "给出具体时间选项而不是开放式「有空约」"],
        avoid: ["临时起意", "总让对方组织"], quote: null },
      { n: "6", color: "#B98A9E", title: "对方有事求助", cond: "对方开口借钱 / 求介绍 / 求帮忙。",
        do: ["能帮就帮到点子上，帮不了给替代方案", "帮忙后不挂在嘴边"],
        avoid: ["超出能力硬扛", "帮忙时摆出施恩姿态"], quote: null },
      { n: "7", color: "#E39D92", title: "关系升温节点", cond: "对方开始和你分享秘密 / 拉你进圈。",
        do: ["保守对方的秘密，这是信任存款", "用同样的深度回应（交换一件自己的事）"],
        avoid: ["把对方的秘密当谈资"], quote: warmQ ? `升温证据：${warmQ}` : null },
      { n: "8", color: "#8FA8C9", title: "聚会后维护", cond: "见面结束后。",
        do: ["当天发一条复盘（照片/趣事）", "把见面聊到的事落实（说好推荐的歌就发）"],
        avoid: ["见完就消失", "每次见面都要对方主动提"], quote: null },
    ];
    if (relation === "work") return [
      { n: "1", color: "#E39D92", title: "对方主动找你", cond: "对方发来需求 / 问题 / 确认。",
        do: ["15 分钟内响应，先确认收到再处理", "给出明确的时间预期：「今天 18 点前回复方案」"],
        avoid: ["已读不回", "答应模糊的时间"], quote: null },
      { n: "2", color: "#8FA8C9", title: "我联系对方", cond: "推进业务 / 同步进度。",
        do: ["一次说清：背景 + 需求 + 期望时间", "文字为主，关键节点电话跟进"],
        avoid: ["60 秒长语音", "碎片化连续轰炸"], quote: null },
      { n: "3", color: "#D9B25F", title: "对方迟迟不回", cond: "超过预期时间没反馈。",
        do: ["隔天轻推一次：「XX 方案您看方便吗，需要我调整随时说」", "换渠道（邮件/电话）"],
        avoid: ["连环追问", "上情绪（「您是不是不想合作了」）"], quote: null },
      { n: "4", color: "#C97C6E", title: "对方不满 / 有异议", cond: "投诉、质疑、要求改。",
        do: ["先认账再解释：「这块确实是我考虑不周，马上补」", "给出补救动作和时间"],
        avoid: ["推卸责任", "和客户争对错"], quote: null },
      { n: "5", color: "#8FB383", title: "★ 推进成交（核心分支）", cond: "需求已明、方案已过，就差临门一脚。",
        do: ["给选择题不是判断题：「A 方案还是 B 方案？」", "制造合理的时间锚点（排期/名额/优惠）"],
        avoid: ["逼单式三连", "报价后自己先松口降价"], quote: null },
      { n: "6", color: "#B98A9E", title: "出现比价 / 竞争者", cond: "对方提到别家方案 / 价格。",
        do: ["不贬低对手，客观对比差异", "强调服务/响应/风险兜底等非价格价值"],
        avoid: ["竞品攻击", "立刻无条件降价（会显得之前报价没诚意）"], quote: null },
      { n: "7", color: "#E39D92", title: "关系升温节点", cond: "对方开始聊业务之外的事（家庭/爱好）。",
        do: ["记住对方提过的私事（孩子/爱好），下次自然接上", "适当回应自己的同类信息，对等交换"],
        avoid: ["过度殷勤", "打探隐私"], quote: null },
      { n: "8", color: "#8FA8C9", title: "合作达成后维护", cond: "签约 / 交付完成。",
        do: ["定期回访使用情况", "节日轻问候 + 行业信息分享"],
        avoid: ["交付完就消失（转介绍就没了）", "每逢联系必有新推销"], quote: null },
    ];
    return [
      { n: "1", color: "#E39D92", title: "家人主动联系你", cond: "家人发来问候 / 关心 / 家常。",
        do: ["当天回，哪怕一句「在忙，晚上视频」", "追问具体细节（「今天做了什么」比「嗯」强百倍）"],
        avoid: ["隔天才回", "只回「嗯」「哦」「知道」"], quote: shareQ ? `家人说过：${shareQ}` : null },
      { n: "2", color: "#8FA8C9", title: "我主动问候", cond: "想起家人时。",
        do: ["分享自己的生活照片（吃饭/上课/工作），家人要的是画面感", "固定频率：每周至少一次语音/视频"],
        avoid: ["只在缺钱时出现"], quote: null },
      { n: "3", color: "#D9B25F", title: "联系变少 / 冷场", cond: "很久没说话，不知道聊什么。",
        do: ["用一张今天的照片开启话题", "问家里的近况：老人身体/猫狗/邻居"],
        avoid: ["觉得尴尬就不联系", "报喜不报忧到失联"], quote: null },
      { n: "4", color: "#C97C6E", title: "家人担心 / 念叨你", cond: "催起床/吃饭/结婚/回家。",
        do: ["先接情绪：「知道你们担心我」，再讲你的安排", "用具体行动反馈（晒按时吃饭的照片）"],
        avoid: ["顶嘴「你们不懂」", "敷衍应承然后照旧"], quote: stressQ ? `家人说过：${stressQ}` : null },
      { n: "5", color: "#8FB383", title: "★ 想加深陪伴（核心分支）", cond: "想为家人多做一点。",
        do: ["回家时全身心陪伴：放下手机的那两个小时比礼物珍贵", "教家人用新事物（视频通话/线上买菜），耐心翻倍"],
        avoid: ["人在心不在", "用红包代替交流"], quote: null },
      { n: "6", color: "#B98A9E", title: "代际分歧", cond: "观念冲突：工作/婚恋/花钱。",
        do: ["先听完，复述对方的担心（「你们是怕我……」），再表达自己", "用「我最近在考虑……」代替「你们别管我」"],
        avoid: ["硬杠对错", "冷战式不联系"], quote: null },
      { n: "7", color: "#E39D92", title: "温情时刻", cond: "家人说了暖心的话 / 寄了东西。",
        do: ["郑重表达感谢，不把家人的好当理所当然", "拍一张「收到」的照片发回去"],
        avoid: ["一句「知道了」带过"], quote: warmQ ? `温情证据：${warmQ}` : null },
      { n: "8", color: "#8FA8C9", title: "长期维护", cond: "日常相处。",
        do: ["把家人的生日/体检日期记进日历", "出差/旅行报平安"],
        avoid: ["把最坏的脾气留给最亲的人"], quote: null },
    ];
  }

  // ---------------- 时间轴 ----------------
  function buildTimeline(relation) {
    if (relation === "romance") return [
      { phase: "阶段一 · 本周", title: "降一点热度，稳住节奏", body: "消息占比往 50~55% 收：少发无内容的戳聊，多分享有信息量的日常（图片/趣事/音乐）。既保持存在感，又不显得粘人。" },
      { phase: "阶段二 · 未来两周", title: "保温 + 埋下见面伏笔", body: "交换生活碎片，用 TA 感兴趣的话题维持热度。顺口提一次「改天一起去 XX」——先让 TA 有心理预期，不强约。" },
      { phase: "阶段三 · 落地邀约", title: "约一个「TA 本来就要做的事」", body: "首选 TA 的高频场景（自习/跑步/常去的地方），用「顺路/顺便」框架提出。被婉拒就换场景，见决策树 ⑤ 号分支。" },
      { phase: "阶段四 · 见面后", title: "以见面为契机二次升温", body: "见面当晚自然复盘，借见面事件延展话题。第二次邀约间隔 3~5 天。若 TA 开始主动约你，再考虑把关系说开。" },
    ];
    if (relation === "friend") return [
      { phase: "阶段一 · 本周", title: "恢复日常互动", body: "用共同兴趣重启聊天（新歌/比赛/梗图），保持每周 1~2 次有质量的互动。" },
      { phase: "阶段二 · 未来两周", title: "制造共同经历", body: "约一次线下：球局/新店/展/电影。共同经历是友情最扎实的锚点。" },
      { phase: "阶段三 · 落地邀约", title: "给出具体选项", body: "「这周末 A 还是 B？」式的具体邀约，比「有空聚」成功率高一倍。" },
      { phase: "阶段四 · 长期维护", title: "记住对方的事", body: "对方提过的考试/面试/家人生日，主动跟进一句——被记住的感觉就是友情的温度。" },
    ];
    if (relation === "work") return [
      { phase: "阶段一 · 本周", title: "对齐当前节点", body: "把所有进行中的事项列清单，逐条和对方确认状态与下一步，避免「以为推进了其实没动」。" },
      { phase: "阶段二 · 未来两周", title: "推进关键事项", body: "每个节点给出明确的交付时间和责任人。响应保持在 15 分钟内，兑现每一个承诺。" },
      { phase: "阶段三 · 落地成交", title: "给选择题，制造时间锚点", body: "用「A 方案还是 B 方案」推进决策，配合排期/名额等合理锚点，不逼单。" },
      { phase: "阶段四 · 长期维护", title: "定期回访 + 轻问候", body: "交付后回访使用情况；节日轻问候；每次联系带一点对方用得到的信息。" },
    ];
    return [
      { phase: "阶段一 · 本周", title: "先恢复频率", body: "从今天开始每天或隔天联系一次：一张照片、一句问候都行，重点是让家人习惯你的存在。" },
      { phase: "阶段二 · 未来两周", title: "把关心具体化", body: "把「注意身体」换成具体行动：寄点东西、视频教用新功能、约好回家的日期。" },
      { phase: "阶段三 · 落地陪伴", title: "回家 / 见面", body: "安排一次回家或长视频。陪伴的质量 = 放下手机的那几个小时。" },
      { phase: "阶段四 · 长期维护", title: "固定节奏", body: "每周至少一次语音，节日和生日有表示。家人要的不多，是有规律的惦记。" },
    ];
  }

  // ---------------- 解读 ----------------
  function buildInsight(stats, relation, chatName) {
    const rel = RELATIONS[relation];
    const me = rel.me, other = rel.other;
    const pts = [];
    pts.push(`在 ${stats.days} 天里，你们交换了 ${stats.total} 条消息：你 ${stats.me_n} 条（${stats.me_ratio}%），${other} ${stats.other_n} 条（${Math.round((100 - stats.me_ratio) * 10) / 10}%）。`);
    if (stats.night_ratio >= 20)
      pts.push(`深夜（22 点后）消息占 ${stats.night_ratio}%——这个时段人最放松、也最真实，能在这个时段稳定聊下去，说明彼此愿意把「不设防的时间」留给对方。`);
    else
      pts.push("聊天集中在白天时段，深夜交流不多。如果想让关系更深，可以试着在晚间聊一两个更软的话题。");
    if (stats.gap_other !== null)
      pts.push(`${other} 的回复中位间隔 ${stats.gap_other} 分钟` + (stats.gap_other <= 5 ? "，是「即问即答」的热聊状态。" : "，节奏偏从容。对照这个基线判断「慢回」是忙还是冷。"));
    if (stats.init_other > 0)
      pts.push(`${other} 主动开聊 ${stats.init_other} 次，你不是单方面拉动，这是关系健康的关键信号。`);
    else
      pts.push(`这段时间的对话几乎都由你先开口。试着制造一些「钩子」（分享到一半留悬念），把主动的位置分给 ${other} 一些。`);
    if (relation === "romance") pts.push("暧昧期的核心目标不是聊得更多，而是「把线上的热落成线下的见面」——见决策树 ⑤ 号分支。");
    else if (relation === "work") pts.push("职场对话的质量看两件事：响应的速度和兑现承诺的密度。把每个「回头再说」都变成「什么时候、谁来做」。");
    else if (relation === "family") pts.push("对家人来说，「被记得」比「被需要」更重要。频率比内容重要，具体比客气重要。");
    return pts;
  }

  // ---------------- 汇总 ----------------
  function analyze(messages, relation, chatName) {
    if (!RELATIONS[relation]) relation = "romance";
    const stats = computeStats(messages);
    if (!stats) throw new Error("没有可分析的消息（时间范围内无记录）");
    return {
      meta: {
        chat: chatName || "聊天对象", relation, relation_label: RELATIONS[relation].label,
        generated_at: new Date().toLocaleString("zh-CN", { hour12: false }),
      },
      stats, topics: computeTopics(messages, relation),
      signals: detectSignals(messages, stats, relation),
      tree: buildTree(messages, stats, relation),
      timeline: buildTimeline(relation),
      insight: buildInsight(stats, relation, chatName),
    };
  }

  // ---------------- 报告渲染 ----------------
  const REPORT_CSS = `
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
`;

  function renderReport(pkg) {
    const s = pkg.stats, m = pkg.meta, signals = pkg.signals;
    const statsCards = [
      ["pink", s.total, `有效消息总数（${s.days} 天）`],
      ["blue", s.night_ratio + "%", "深夜（22 点后）聊天占比"],
      ["green", (s.gap_other === null ? "-" : s.gap_other) + " 分钟", "对方回复中位间隔"],
      ["yellow", `${s.me_ratio}% : ${Math.round((100 - s.me_ratio) * 10) / 10}%`, "你 : 对方 消息占比"],
      ["pink", `${s.init_me} : ${s.init_other}`, "主动开聊次数（你 : 对方）"],
      ["blue", s.voice_other + " 条", "对方发的语音"],
    ].map(([c, num, lab]) => `<div class="stat ${c}"><b>${esc(num)}</b><span>${esc(lab)}</span></div>`).join("");

    const sigHtml = (items, cls) => {
      const lis = (items || []).map(i =>
        `<li><b>${esc(i.title)}</b>${i.detail ? `：${esc(i.detail)}` : ""}` +
        (i.quote ? ` <span class="q">（${esc(i.quote)}）</span>` : "") + `</li>`).join("");
      return `<div class="signal ${cls}"><h3>${(items || []).length} 条</h3><ul>${lis || "<li>暂无</li>"}</ul></div>`;
    };

    const treeHtml = pkg.tree.map(b => `<div class="branch"${b.n === "5" ? " open" : ""}>
<div class="branch-wrap">
<details open><summary><span class="n" style="background:${esc(b.color)}">${esc(b.n)}</span><h4>${esc(b.title)}</h4><span class="caret">▾</span></summary>
<div class="body">
<div class="node cond"><span class="k">判断</span>${esc(b.cond)}</div>
<div class="node do"><span class="k">行动</span><ul>${(b.do || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
<div class="node avoid"><span class="k">禁忌</span><ul>${(b.avoid || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
${b.quote ? `<p class="quote">${esc(b.quote)}</p>` : ""}
</div></details></div></div>`).join("");

    const timelineHtml = pkg.timeline.map(t =>
      `<div class="t-item"><div class="t-time">${esc(t.phase)}</div><h4>${esc(t.title)}</h4><p>${esc(t.body)}</p></div>`).join("");

    const insightHtml = pkg.insight.map(p => `<p style="margin:8px 0;font-size:13.5px;color:#7A6557">• ${esc(p)}</p>`).join("");

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(m.chat)} · 聊天复盘与策略决策树</title>
<style>${REPORT_CSS}</style></head><body><div class="wrap">
<div class="hero">
<span class="chip">对象：<b>${esc(m.chat)}</b></span>
<span class="chip">关系定位：<b>${esc(m.relation_label)}</b></span>
<span class="chip">时间段：<b>${esc(s.first_ts)} ~ ${esc(s.last_ts)}</b></span>
<span class="chip">记录条数：<b>${s.total} 条</b></span>
<h1>聊天复盘 · 策略决策树</h1>
<p>${esc(pkg.insight[0] || "")}</p>
<p style="font-size:12px;color:#B49C8C;margin-top:10px">🔒 本报告由「微信聊天分析站」在浏览器本地生成，数据未上传任何地方，请勿外传。</p>
</div>
<section><h2>① 关系速览</h2><div class="grid">${statsCards}</div></section>
<section><h2>② 核心解读</h2><div class="card">${insightHtml}</div></section>
<section><h2>③ 信号灯</h2>
<div class="card">${sigHtml(signals.green, "green")}
<div style="margin-top:12px">${sigHtml(signals.yellow, "yellow")}</div>
<div style="margin-top:12px">${sigHtml(signals.red, "red")}</div></div></section>
<section><h2>④ 策略决策树</h2>${treeHtml}</section>
<section><h2>⑤ 推进时间轴</h2><div class="card">${timelineHtml}</div></section>
<footer>由「微信聊天分析站」在浏览器本地生成 · ${esc(m.generated_at)}</footer>
</div></body></html>`;
  }

  function downloadReport(pkg) {
    const html = renderReport(pkg);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `聊天复盘_${pkg.meta.chat}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { RELATIONS, analyze, renderReport, downloadReport, computeStats, computeTopics, findQuote };
})();
