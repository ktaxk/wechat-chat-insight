# -*- coding: utf-8 -*-
"""微信适配层：账户检测、密钥提取、会话/联系人/结构化消息查询、手动导入解析。

自动提取能力基于 vendored wechat_cli 核心库（Apache-2.0，见 vendor/LICENSE）。
所有数据仅在本机处理。
"""
import ctypes
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
from contextlib import closing
from datetime import datetime

_FROZEN = getattr(sys, "frozen", False)
if _FROZEN:
    # PyInstaller 冻结运行时：data 目录放 exe 旁，vendor 在解包目录
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    VENDOR = os.path.join(sys._MEIPASS, "vendor")
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    VENDOR = os.path.join(BASE_DIR, "vendor")
DATA_DIR = os.path.join(BASE_DIR, "data")
if VENDOR not in sys.path:
    sys.path.insert(0, VENDOR)

import wechat_cli.core.contacts as wx_contacts          # noqa: E402
from wechat_cli.core.config import _SYSTEM              # noqa: E402
from wechat_cli.core.context import AppContext          # noqa: E402
from wechat_cli.core.messages import (                  # noqa: E402
    _format_message_text, _load_name2id_maps, _query_messages, _split_msg_type,
    decompress_content, format_msg_type, resolve_chat_context,
)
from wechat_cli.keys import extract_keys as _extract_keys  # noqa: E402

CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
KEYS_PATH = os.path.join(DATA_DIR, "all_keys.json")
DECRYPTED_DIR = os.path.join(DATA_DIR, "decrypted")
IMPORT_DIR = os.path.join(DATA_DIR, "imports")

_app = None
_app_db_dir = None


def _ensure_dirs():
    for d in (DATA_DIR, DECRYPTED_DIR, IMPORT_DIR):
        os.makedirs(d, exist_ok=True)


# ---------------------------------------------------------------- 账户检测

def _windows_data_roots():
    """读取微信 4.x 配置 ini，返回所有数据根目录。"""
    appdata = os.environ.get("APPDATA", "")
    config_dir = os.path.join(appdata, "Tencent", "xwechat", "config")
    roots = []
    if os.path.isdir(config_dir):
        for ini_file in glob.glob(os.path.join(config_dir, "*.ini")):
            try:
                content = None
                for enc in ("utf-8", "gbk"):
                    try:
                        with open(ini_file, "r", encoding=enc) as f:
                            content = f.read(1024).strip()
                        break
                    except UnicodeDecodeError:
                        continue
                if content and not any(c in content for c in "\n\r\x00") and os.path.isdir(content):
                    roots.append(content)
            except OSError:
                continue
    return roots


def detect_accounts():
    """返回候选账号列表: [{"db_dir":..., "account":..., "mtime":...}]，按最近活跃排序。"""
    candidates = {}
    roots = _windows_data_roots() if _SYSTEM == "windows" else [
        os.path.expanduser("~/Documents/xwechat_files"),
        os.path.expanduser("~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"),
    ]
    roots = [r for r in roots if r and os.path.isdir(r)]
    for root in roots:
        for match in glob.glob(os.path.join(root, "xwechat_files", "*", "db_storage")):
            if os.path.isdir(match):
                candidates[os.path.normcase(os.path.normpath(match))] = match

    accounts = []
    for db_dir in candidates.values():
        account_dir = os.path.basename(os.path.dirname(db_dir))
        msg_dir = os.path.join(db_dir, "message")
        try:
            mtime = os.path.getmtime(msg_dir)
        except OSError:
            mtime = 0
        accounts.append({
            "db_dir": db_dir,
            "account": account_dir,
            "mtime": mtime,
            "active": bool(mtime and (datetime.now().timestamp() - mtime) < 86400 * 14),
        })
    accounts.sort(key=lambda a: -a["mtime"])
    return accounts


def wechat_running():
    """尽力检测微信进程是否在运行。"""
    try:
        if _SYSTEM == "windows":
            procs = set()
            snapshot = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x2, 0)
            if snapshot == -1:
                return None
            class PROCESSENTRY32(ctypes.Structure):
                _fields_ = [("dwSize", ctypes.c_ulong), ("cntUsage", ctypes.c_ulong),
                            ("th32ProcessID", ctypes.c_ulong), ("th32DefaultHeapID", ctypes.c_void_p),
                            ("th32ModuleID", ctypes.c_ulong), ("cntThreads", ctypes.c_ulong),
                            ("th32ParentProcessID", ctypes.c_ulong), ("pcPriClassBase", ctypes.c_long),
                            ("dwFlags", ctypes.c_ulong), ("szExeFile", ctypes.c_char * 260)]
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            ok = ctypes.windll.kernel32.Process32First(snapshot, ctypes.byref(entry))
            while ok:
                procs.add(entry.szExeFile.decode("gbk", errors="ignore").lower())
                ok = ctypes.windll.kernel32.Process32Next(snapshot, ctypes.byref(entry))
            ctypes.windll.kernel32.CloseHandle(snapshot)
            return "weixin.exe" in procs or "wechat.exe" in procs
        out = subprocess.run(["pgrep", "-f", "wechat|WeChat|weixin"], capture_output=True, text=True).stdout
        return bool(out.strip())
    except Exception:
        return None


# ---------------------------------------------------------------- 密钥与配置

def reset_contact_cache():
    wx_contacts._contact_names = None
    wx_contacts._contact_full = None
    wx_contacts._self_username = None


def init_account(db_dir, force=False):
    """为指定账号提取密钥并写配置。返回 {"ok":..., "count":...} 或抛异常。"""
    _ensure_dirs()
    db_dir = os.path.normpath(db_dir)
    if not os.path.isdir(db_dir):
        raise RuntimeError(f"数据目录不存在: {db_dir}")
    if force and os.path.exists(KEYS_PATH):
        os.remove(KEYS_PATH)
    cfg = {
        "db_dir": db_dir,
        "keys_file": KEYS_PATH,
        "decrypted_dir": DECRYPTED_DIR,
        "decoded_image_dir": os.path.join(DATA_DIR, "decoded_images"),
    }
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    global _app, _app_db_dir
    _app = None
    _app_db_dir = None
    reset_contact_cache()
    result = _extract_keys(db_dir, KEYS_PATH)
    count = len(result) if isinstance(result, dict) else 0
    return {"ok": True, "count": count, "db_dir": db_dir}


def keys_ready():
    return os.path.exists(CONFIG_PATH) and os.path.exists(KEYS_PATH)


def get_app():
    """返回 AppContext；未初始化时抛 RuntimeError。"""
    global _app, _app_db_dir
    if not keys_ready():
        raise RuntimeError("尚未初始化：请先提取密钥")
    db_dir = os.path.normpath(load_state()["db_dir"])
    if _app is None or _app_db_dir != db_dir:
        reset_contact_cache()
        _app = AppContext(CONFIG_PATH)
        _app_db_dir = db_dir
    return _app


def load_state():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


# ---------------------------------------------------------------- 会话 / 联系人

def _clean_summary(summary, msg_type_label):
    if isinstance(summary, bytes):
        summary = decompress_content(summary, 4) or ""
    summary = str(summary or "")
    if ":\n" in summary:
        summary = summary.split(":\n", 1)[1]
    summary = re.sub(r"<[^>]+>", "", summary).strip()
    if not summary and msg_type_label not in ("文本",):
        summary = f"[{msg_type_label}]"
    return summary[:120]


def list_sessions(limit=500):
    app = get_app()
    path = app.cache.get(os.path.join("session", "session.db"))
    if not path:
        return []
    names = wx_contacts.get_contact_names(app.cache, app.decrypted_dir)
    rows = []
    with closing(sqlite3.connect(path)) as conn:
        try:
            rows = conn.execute(
                "SELECT username, unread_count, summary, last_timestamp, last_msg_type, "
                "last_msg_sender, last_sender_display_name FROM SessionTable "
                "WHERE last_timestamp > 0 ORDER BY last_timestamp DESC LIMIT ?",
                (limit,),
            ).fetchall()
        except sqlite3.Error:
            return []
    results = []
    for username, unread, summary, ts, msg_type, sender, sender_name in rows:
        display = names.get(username, username)
        is_group = "@chatroom" in username
        sender_display = ""
        if is_group and sender:
            sender_display = names.get(sender, sender_name or sender)
        results.append({
            "chat": display,
            "username": username,
            "is_group": is_group,
            "is_subscription": username.startswith("gh_"),
            "unread": unread or 0,
            "last_message": _clean_summary(summary, format_msg_type(msg_type)),
            "msg_type": format_msg_type(msg_type),
            "sender": sender_display,
            "timestamp": ts,
            "time": datetime.fromtimestamp(ts).strftime("%m-%d %H:%M"),
        })
    return results


def list_contacts(limit=5000):
    app = get_app()
    full = wx_contacts.get_contact_full(app.cache, app.decrypted_dir)
    out = []
    for c in full:
        u = c.get("username") or ""
        if not u or u in ("filehelper", "notifymessage") or u == "brandsessionholder":
            continue
        out.append({
            "username": u,
            "remark": c.get("remark") or "",
            "nick": c.get("nick_name") or "",
            "is_group": "@chatroom" in u,
            "is_subscription": u.startswith("gh_"),
        })
    return out[:limit]


# ---------------------------------------------------------------- 消息查询

def _is_personal(u):
    if not u:
        return False
    return not (u.startswith("gh_") or u.endswith("@openim")
                or u.endswith("@chatroom") or "sessionholder" in u or u == "filehelper")


def get_history(chat, start=None, end=None, limit=100000):
    """返回归一化消息列表:
    [{"ts":unix秒, "time":"YYYY-MM-DD HH:MM", "sender":"me|other|成员名",
      "sender_username":..., "type":基础类型, "type_label":..., "text":展示文本}]
    按时间升序。"""
    app = get_app()
    names = wx_contacts.get_contact_names(app.cache, app.decrypted_dir)
    ctx = resolve_chat_context(chat, app.msg_db_keys, app.cache, app.decrypted_dir)
    if not ctx:
        raise RuntimeError(f"找不到聊天对象: {chat}")
    if not ctx.get("message_tables"):
        return {"chat": ctx["display_name"], "username": ctx["username"],
                "is_group": ctx["is_group"], "messages": []}

    start_ts, end_ts = _parse_ts(start), _parse_ts(end, is_end=True)
    collected = []
    for table in ctx["message_tables"]:
        try:
            with closing(sqlite3.connect(table["db_path"])) as conn:
                id_to_username = _load_name2id_maps(conn)
                offset = 0
                while len(collected) < limit:
                    rows = _query_messages(conn, table["table_name"],
                                           start_ts=start_ts, end_ts=end_ts,
                                           limit=500, offset=offset)
                    if not rows:
                        break
                    offset += len(rows)
                    for local_id, local_type, create_time, real_sender_id, content, ct in rows:
                        text_content = decompress_content(content, ct)
                        if text_content is None:
                            text_content = ""
                        sender_from_content, text = _format_message_text(
                            local_id, local_type, text_content, ctx["is_group"],
                            ctx["username"], ctx["display_name"], names, app.display_name_fn,
                            db_dir=app.db_dir, create_time_ts=create_time,
                        )
                        base_type, _sub = _split_msg_type(local_type)
                        sender_username = id_to_username.get(real_sender_id, "")
                        if ctx["is_group"]:
                            sender_label = app.display_name_fn(sender_username, names) if sender_username else ""
                        else:
                            sender_label = "me" if sender_username != ctx["username"] else "other"
                        collected.append({
                            "ts": create_time,
                            "time": datetime.fromtimestamp(create_time).strftime("%Y-%m-%d %H:%M"),
                            "sender": sender_label or "me",
                            "sender_username": sender_username,
                            "type": base_type,
                            "type_label": format_msg_type(local_type),
                            "text": text,
                        })
                    if len(rows) < 500:
                        break
        except sqlite3.Error:
            continue
        if len(collected) >= limit:
            break
    collected.sort(key=lambda m: m["ts"])
    return {
        "chat": ctx["display_name"],
        "username": ctx["username"],
        "is_group": ctx["is_group"],
        "messages": collected[:limit],
    }


def _parse_ts(value, is_end=False):
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(str(value).strip(), fmt)
            if is_end and fmt == "%Y-%m-%d":
                dt = dt.replace(hour=23, minute=59, second=59)
            return int(dt.timestamp())
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------- 手动导入

_LINE_RE1 = re.compile(r"^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,30})[:：]\s*(.*)$")
_LINE_RE2 = re.compile(r"^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)[ T](\d{1,2}[:时]\d{2}(?:[:分]\d{2})?)\s+([^:：\s]{1,30})[:：]\s*(.*)$")
_ME_LABELS = {"me", "我", "自己", "self", "i", "本人"}


def _norm_sender(label):
    label = (label or "").strip()
    if label.lower() in _ME_LABELS:
        return "me"
    return "other"


def _guess_type(text):
    t = text or ""
    for tag, bt in (("[表情]", 47), ("[图片]", 3), ("[语音]", 34), ("[视频]", 43),
                    ("[撤回]", 10002), ("[系统]", 10000), ("[文件]", 49), ("[链接", 49),
                    ("[通话]", 50)):
        if t.startswith(tag):
            return bt
    return 1


def parse_import(content, name=""):
    """解析导入的记录，返回与 get_history 相同结构的 dict。支持:
    1) wechat-cli history JSON  2) [时间] 昵称: 内容 文本  3) CSV（自动识别表头）"""
    content = (content or "").lstrip("\ufeff")
    if not content.strip():
        raise RuntimeError("导入内容为空")

    # 1) JSON
    if content.strip().startswith("{"):
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            raise RuntimeError("JSON 解析失败")
        raw = data.get("messages", []) if isinstance(data, dict) else data
        if isinstance(raw, list):
            msgs = []
            for item in raw:
                if isinstance(item, str):
                    msgs.append(item)
                elif isinstance(item, dict):
                    ts = item.get("ts") or item.get("timestamp") or item.get("create_time")
                    sender = item.get("sender") or item.get("sender_name") or item.get("real_sender_id") or "other"
                    text = item.get("text") or item.get("content") or ""
                    mtype = item.get("type") or (1 if text else 0)
                    msgs.append({"ts": int(ts) if str(ts).isdigit() else None,
                                 "time": "", "sender": _norm_sender(sender),
                                 "sender_username": "", "type": mtype,
                                 "type_label": format_msg_type(mtype), "text": str(text)})
            name = name or (data.get("chat") if isinstance(data, dict) else "")
            return _finish_import(msgs, name, is_json_struct=any(isinstance(i, dict) for i in raw))
        raise RuntimeError("不支持的 JSON 结构（需要 messages 数组）")

    # 2) 文本行
    lines = [l.rstrip() for l in content.splitlines() if l.strip()]
    parsed, failed = [], 0
    for line in lines:
        m = _LINE_RE1.match(line) or _LINE_RE2.match(line)
        if not m:
            failed += 1
            continue
        day, hhmm, sender, text = m.groups()
        day = day.replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-")
        hhmm = hhmm.replace("时", ":").replace("分", "").replace("点", ":")
        try:
            ts = datetime.strptime(f"{day} {hhmm}", "%Y-%m-%d %H:%M")
        except ValueError:
            failed += 1
            continue
        parsed.append({"ts": int(ts.timestamp()), "time": ts.strftime("%Y-%m-%d %H:%M"),
                       "sender": _norm_sender(sender), "sender_username": "",
                       "type": _guess_type(text), "type_label": "",
                       "text": text})
    if len(parsed) > len(lines) // 2:
        return _finish_import(parsed, name, is_json_struct=True)

    # 3) CSV
    import csv as csv_mod
    from io import StringIO
    try:
        dialect = csv_mod.Sniffer().sniff(content[:4096], delimiters=",;\t")
    except csv_mod.Error:
        raise RuntimeError("无法识别格式：请提供 wechat-cli JSON、聊天文本或 CSV")
    rows = list(csv_mod.reader(StringIO(content), dialect))
    if not rows:
        raise RuntimeError("CSV 为空")
    header = [str(h).strip().lower() for h in rows[0]]
    cols = {}
    for i, h in enumerate(header):
        if any(k in h for k in ("时间", "日期", "time", "date")) and "时间" not in cols:
            cols["时间"] = i
        elif any(k in h for k in ("发送", "sender", "from", "昵称", "name")) and "发送" not in cols:
            cols["发送"] = i
        elif any(k in h for k in ("内容", "消息", "content", "text", "msg")) and "内容" not in cols:
            cols["内容"] = i
    if len(cols) < 3:
        raise RuntimeError("CSV 缺少列：需要 时间/发送者/内容 三列（可自动识别中文或英文表头）")
    parsed = []
    for row in rows[1:]:
        if len(row) < 3 or not row[cols["时间"]].strip():
            continue
        try:
            ts = _parse_ts(row[cols["时间"]]) or _parse_ts(row[cols["时间"]].replace("/", "-"))
            if not ts:
                continue
        except Exception:
            continue
        text = row[cols["内容"]]
        parsed.append({"ts": ts, "time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M"),
                       "sender": _norm_sender(row[cols["发送"]]), "sender_username": "",
                       "type": _guess_type(text), "type_label": "", "text": text})
    return _finish_import(parsed, name, is_json_struct=True)


def _finish_import(msgs, name, is_json_struct):
    out = []
    for m in msgs:
        if not m.get("ts"):
            try:
                m["ts"] = _parse_ts(m.get("time"))
            except Exception:
                continue
            if not m["ts"]:
                continue
        ts = int(m["ts"])
        m["ts"] = ts
        m["time"] = m.get("time") or datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
        m["type_label"] = m.get("type_label") or format_msg_type(m.get("type") or 1)
        m["text"] = str(m.get("text") or "")
        out.append(m)
    out.sort(key=lambda m: m["ts"])
    others = {m["sender"] for m in out if m["sender"] != "me"}
    other_label = next(iter(others)) if others else "对方"
    for m in out:
        if m["sender"] != "me" and m["sender"] != "other":
            m["sender"] = "other"
    return {"chat": name or "导入记录", "username": "", "is_group": False,
            "messages": out, "imported": True}


# ---------------------------------------------------------------- AI 辅助

def messages_to_bundle(messages, max_chars=16000):
    """把消息列表压缩成适合喂给 LLM 的文本。"""
    lines = []
    used = 0
    for m in messages:
        line = f"[{m['time']}] {m['sender']}: {m['text']}"
        if used + len(line) > max_chars:
            lines.append("……（中间省略）……")
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)
