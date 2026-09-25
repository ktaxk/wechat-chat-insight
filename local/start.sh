#!/usr/bin/env bash
# 微信聊天分析站 - macOS/Linux 启动脚本（自动提取仅在 macOS 微信 4.x 可用）
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] 未找到 python3，请先安装 Python 3.10+"
  exit 1
fi
python3 -c "import click, Crypto, zstandard" >/dev/null 2>&1 || {
  echo "首次运行：正在安装依赖..."
  python3 -m pip install -r requirements.txt || { echo "[ERROR] 依赖安装失败"; exit 1; }
}
echo "启动本地服务（浏览器会自动打开）..."
python3 server.py
