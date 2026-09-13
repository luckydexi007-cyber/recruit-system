@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 车辆与交通学院招新系统 · 服务运行中
echo ============================================================
echo   车辆与交通学院 · 团总支学生会 招新系统
echo ============================================================
echo.
echo   【本机访问】在电脑浏览器打开：
echo       http://localhost:3000
echo.
echo   【手机/其他设备访问】用下面这个地址（需与本电脑同一WiFi）：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "IP=%%a"
    call :showip "%%a"
)
echo.
echo   终端管理员账号：admin    密码：admin123
echo   （在登录页双击顶部标题栏可唤出隐藏入口）
echo.
echo ============================================================
echo   服务运行中...  请勿关闭此窗口（关闭即停止服务）
echo ============================================================
echo.
node server.js
echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
exit /b

:showip
set "ip=%~1"
set "ip=%ip: =%"
echo       http://%ip%:3000
exit /b
