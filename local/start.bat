@echo off
chcp 65001 >nul
title 微信聊天分析站
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 Python，请先安装 Python 3.10+ 并勾选 "Add to PATH"
  echo 下载地址: https://www.python.org/downloads/
  pause
  exit /b 1
)

python -c "import click, Crypto, zstandard" >nul 2>nul
if errorlevel 1 (
  echo 首次运行：正在安装依赖（click / pycryptodome / zstandard）...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [ERROR] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo 启动本地服务（浏览器会自动打开）...
python server.py
pause
