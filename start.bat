@echo off
rem Markdown Reader one-click launcher (double-click = default workspace + port 8765)
rem Usage: start.bat [--root D:/workspace] [--port 8766] [--no-open] [--reuse]
cd /d "%~dp0"
python launch.py %*
