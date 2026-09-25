@echo off
chcp 65001 >nul
title 打包微信聊天分析站
cd /d "%~dp0..\local"

if not exist web (
  echo 复制前端资源 web\ ...
  xcopy /e /i /q "..\web" "web" >nul
)
if exist dist rd /s /q dist
if exist build rd /s /q build

echo 开始打包（约 2-5 分钟）...
python -m PyInstaller --onefile --name "WeChatInsight" ^
  --paths vendor ^
  --add-data "web;web" ^
  --add-data "vendor;vendor" ^
  --hidden-import click ^
  --hidden-import zstandard ^
  --hidden-import Crypto ^
  --hidden-import Crypto.Cipher.AES ^
  --hidden-import xml ^
  --hidden-import xml.etree ^
  --hidden-import xml.etree.ElementTree ^
  --hidden-import wechat_cli.keys.scanner_windows ^
  --hidden-import wechat_cli.keys.scanner_linux ^
  --hidden-import wechat_cli.keys.scanner_macos ^
  --hidden-import wechat_cli.core.contacts ^
  server.py

echo.
if exist dist\WeChatInsight.exe (
  echo ✅ 打包完成: dist\WeChatInsight.exe
) else (
  echo ❌ 打包失败，请查看上方错误
)
pause
