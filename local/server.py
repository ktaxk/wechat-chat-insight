# -*- coding: utf-8 -*-
"""微信聊天分析站 —— 本地 HTTP 服务（纯标准库）。

启动: python server.py [--port 8688] [--no-browser]
安全: 仅绑定 127.0.0.1，所有数据只在本机处理。
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

if getattr(sys, "frozen", False):
    # PyInstaller 冻结运行时：data 目录放 exe 旁边
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _static_dirs():
    """静态资源目录候选（仓库内用 ../web，独立分发用 local/web，冻结 exe 用 _MEIPASS/web）。"""
    dirs = []
    if getattr(sys, "frozen", False):
        dirs.append(os.path.join(sys._MEIPASS, "web"))
    dirs += [
        os.path.join(BASE_DIR, "..", "web"),
        os.path.join(BASE_DIR, "web"),
        os.path.join(BASE_DIR, "static"),
    ]
    return dirs


def _resolve_static(name):
    name = name.lstrip("/\\")
    for root in _static_dirs():
        target = os.path.normpath(os.path.join(root, name))
        if target.startswith(os.path.normpath(root)) and os.path.isfile(target):
            return target
    return None

DATA_DIR = os.path.join(BASE_DIR, "data")
IMPORT_DIR = os.path.join(DATA_DIR, "imports")
LLM_CONFIG_PATH = os.path.join(DATA_DIR, "llm_config.json")

import wechat_adapter as wx          # noqa: E402
import analysis as an                # noqa: E402
import ai_analysis as ai_mod         # noqa: E402


def _json(obj, status=200, extra_headers=None):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return status, body, "application/json; charset=utf-8", extra_headers or {}


def _err(msg, status=400):
    return _json({"ok": False, "error": msg}, status)


def _load_messages(params):
    """按参数加载消息：import_id 优先，否则 chat。返回 (data_dict, messages)。"""
    import_id = params.get("import_id") or (params.get("importId"))
    if import_id:
        path = os.path.join(IMPORT_DIR, f"{import_id}.json")
        if not os.path.exists(path):
            raise RuntimeError("导入记录不存在，请重新导入")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data, data["messages"]
    chat = params.get("chat")
    if not chat:
        raise RuntimeError("缺少参数 chat 或 import_id")
    data = wx.get_history(chat, params.get("start"), params.get("end"))
    return data, data["messages"]


def _save_import(name, messages):
    import_id = uuid.uuid4().hex[:12]
    os.makedirs(IMPORT_DIR, exist_ok=True)
    with open(os.path.join(IMPORT_DIR, f"{import_id}.json"), "w", encoding="utf-8") as f:
        json.dump({"name": name, "messages": messages}, f, ensure_ascii=False)
    return import_id


def _load_llm_cfg():
    if os.path.exists(LLM_CONFIG_PATH):
        with open(LLM_CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


class Handler(BaseHTTPRequestHandler):
    server_version = "WeChatInsight/1.0"

    def log_message(self, fmt, *args):  # 安静模式
        pass

    # ---------------- helpers ----------------
    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"_raw": raw.decode("utf-8", errors="replace")}

    def _send(self, status, body, ctype, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.wfile.write(body)

    # ---------------- routing ----------------
    def do_GET(self):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        try:
            if path == "/" or path == "/index.html":
                return self._serve_file("index.html")
            if not path.startswith("/api/"):
                return self._serve_file(path)
            if path == "/api/status":
                return self._api_status()
            if path == "/api/sessions":
                return self._api_sessions(qs)
            if path == "/api/contacts":
                return self._api_contacts(qs)
            if path == "/api/history":
                return self._api_history(qs)
            if path == "/api/imports":
                return self._api_imports()
            if path == "/api/config":
                return self._api_get_config()
            if path == "/api/export-report":
                return self._api_export_report(qs)
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            return self._send(*_err("接口不存在", 404))
        except RuntimeError as e:
            return self._send(*_err(str(e), 400))
        except Exception as e:  # noqa: BLE001
            return self._send(*_err(f"服务异常: {e}", 500))

    def do_POST(self):
        url = urlparse(self.path)
        try:
            body = self._read_body()
            if url.path == "/api/init":
                return self._api_init(body)
            if url.path == "/api/analyze":
                return self._api_analyze(body)
            if url.path == "/api/import":
                return self._api_import(body)
            if url.path == "/api/ask":
                return self._api_ask(body)
            if url.path == "/api/analyze-ai":
                return self._api_analyze_ai(body)
            if url.path == "/api/config":
                return self._api_set_config(body)
            return self._send(*_err("接口不存在", 404))
        except RuntimeError as e:
            return self._send(*_err(str(e), 400))
        except Exception as e:  # noqa: BLE001
            return self._send(*_err(f"服务异常: {e}", 500))

    # ---------------- static ----------------
    def _serve_file(self, name, under=None):
        target = _resolve_static(name) if under is None else os.path.normpath(os.path.join(under, name))
        if not target or not os.path.isfile(target):
            return self._send(*_err("文件不存在", 404))
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        with open(target, "rb") as f:
            return self._send(200, f.read(), ctype)

    # ---------------- api ----------------
    def _api_status(self):
        accounts = wx.detect_accounts()
        cfg_ok = wx.keys_ready()
        llm = _load_llm_cfg()
        return self._send(*_json({
            "ok": True,
            "platform": os.sys.platform,
            "wechat_running": wx.wechat_running(),
            "accounts": accounts,
            "configured": cfg_ok,
            "configured_account": wx.load_state().get("db_dir") if cfg_ok else None,
            "llm_configured": bool(llm.get("api_key")),
        }))

    def _api_init(self, body):
        db_dir = body.get("db_dir")
        if not db_dir:
            return self._send(*_err("缺少 db_dir"))
        try:
            result = wx.init_account(db_dir, force=bool(body.get("force")))
            return self._send(*_json({"ok": True, **result}))
        except RuntimeError as e:
            return self._send(*_err(f"密钥提取失败: {e}\n（请确认微信已登录并在运行中）", 400))

    def _api_sessions(self, qs):
        try:
            limit = min(int(qs.get("limit", ["500"])[0]), 2000)
        except ValueError:
            limit = 500
        return self._send(*_json({"ok": True, "sessions": wx.list_sessions(limit)}))

    def _api_contacts(self, qs):
        try:
            limit = min(int(qs.get("limit", ["5000"])[0]), 10000)
        except ValueError:
            limit = 5000
        return self._send(*_json({"ok": True, "contacts": wx.list_contacts(limit)}))

    def _api_history(self, qs):
        chat = qs.get("chat", [""])[0]
        if not chat:
            return self._send(*_err("缺少 chat"))
        data = wx.get_history(chat, qs.get("start", [""])[0] or None, qs.get("end", [""])[0] or None)
        data["ok"] = True
        return self._send(*_json(data))

    def _api_import(self, body):
        content = body.get("content") or body.get("_raw") or ""
        name = (body.get("name") or "").strip() or "导入记录"
        data = wx.parse_import(content, name)
        import_id = _save_import(name, data["messages"])
        return self._send(*_json({"ok": True, "import_id": import_id,
                                  "chat": name, "count": len(data["messages"])}))

    def _api_imports(self):
        out = []
        if os.path.isdir(IMPORT_DIR):
            for f in os.listdir(IMPORT_DIR):
                if f.endswith(".json"):
                    try:
                        with open(os.path.join(IMPORT_DIR, f), encoding="utf-8") as fh:
                            d = json.load(fh)
                        out.append({"id": f[:-5], "name": d.get("name"), "count": len(d.get("messages", []))})
                    except (OSError, json.JSONDecodeError):
                        continue
        out.sort(key=lambda x: x["id"], reverse=True)
        return self._send(*_json({"ok": True, "imports": out}))

    def _api_analyze(self, body):
        _data, messages = _load_messages(body)
        relation = body.get("relation") or "romance"
        pkg = an.analyze(messages, relation, _data.get("chat") or body.get("chat") or "聊天对象")
        return self._send(*_json({"ok": True, "analysis": pkg}))

    def _api_ask(self, body):
        question = (body.get("question") or "").strip()
        if not question:
            return self._send(*_err("问题不能为空"))
        llm = _load_llm_cfg()
        if not llm.get("api_key"):
            return self._send(*_err("尚未配置 AI：请在设置页填写你自己的 OpenAI 兼容 API Key（聊天内容只会发送给你填写的 API）", 400))
        _data, messages = _load_messages(body)
        relation = body.get("relation") or "romance"
        stats = an.compute_stats(messages)
        if not stats:
            return self._send(*_err("没有可分析的消息"))
        answer = ai_mod.ask_question(llm, messages, stats, relation, question, _data.get("chat") or "")
        return self._send(*_json({"ok": True, "answer": answer}))

    def _api_analyze_ai(self, body):
        llm = _load_llm_cfg()
        if not llm.get("api_key"):
            return self._send(*_err("尚未配置 AI：请在设置页填写你自己的 OpenAI 兼容 API Key", 400))
        _data, messages = _load_messages(body)
        relation = body.get("relation") or "romance"
        base_pkg = an.analyze(messages, relation, _data.get("chat") or body.get("chat") or "聊天对象")
        ai = ai_mod.deep_analysis(llm, messages, base_pkg["stats"], relation,
                                  base_pkg["meta"]["chat"], base_pkg.get("topics"))
        return self._send(*_json({"ok": True, "analysis": base_pkg, "ai": ai}))

    def _api_get_config(self):
        llm = _load_llm_cfg()
        return self._send(*_json({"ok": True, "llm": {
            "base_url": llm.get("base_url", ""), "model": llm.get("model", ""),
            "has_key": bool(llm.get("api_key")),
        }}))

    def _api_set_config(self, body):
        llm = _load_llm_cfg()
        if "base_url" in body:
            llm["base_url"] = (body.get("base_url") or "").strip()
        if "model" in body:
            llm["model"] = (body.get("model") or "").strip()
        if "api_key" in body and body.get("api_key"):
            llm["api_key"] = body["api_key"].strip()
        if body.get("clear_key"):
            llm.pop("api_key", None)
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LLM_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(llm, f, ensure_ascii=False)
        return self._send(*_json({"ok": True}))

    def _api_export_report(self, qs):
        params = {k: v[0] for k, v in qs.items()}
        _data, messages = _load_messages(params)
        relation = params.get("relation") or "romance"
        pkg = an.analyze(messages, relation, _data.get("chat") or params.get("chat") or "聊天对象")
        html = an.render_report(pkg)
        filename = f"聊天复盘_{pkg['meta']['chat']}.html"
        from urllib.parse import quote
        return self._send(200, html, "text/html; charset=utf-8", {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        })


def main():
    parser = argparse.ArgumentParser(description="微信聊天分析站")
    parser.add_argument("--port", type=int, default=8688)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    port = args.port
    for p in range(port, port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    else:
        print("无法绑定端口，请检查 8688-8707 是否被占用")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}/"
    print(f"[微信聊天分析站] 已启动: {url}  (Ctrl+C 退出)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
