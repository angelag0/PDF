@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDF Editor
echo Checking packages...
python -m pip install -q -r requirements.txt
python app.py --open
pause
