@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js
  echo   请先安装： https://nodejs.org  （选 LTS 版本，一路下一步即可）
  echo.
  pause
  exit /b 1
)

echo.
echo   快传 · 局域网版
echo   ----------------------------------------
echo   服务启动后窗口里会打印两个地址：
echo     本机访问   http://localhost:8787
echo     局域网     http://192.168.x.x:8787   ^<-- 发给同事的就是这个
echo.
echo   首次运行如果弹出防火墙提示，请勾选“专用网络”并允许。
echo   关闭这个窗口即停止服务。
echo   ----------------------------------------
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8787"
node server.js
pause
