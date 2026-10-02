@echo off
if exist "%LOCALAPPDATA%\Programs\CodexTokenStatusbar\CodexTokenStatusbar.exe" (
  start "" "%LOCALAPPDATA%\Programs\CodexTokenStatusbar\CodexTokenStatusbar.exe"
) else (
  start "" "%~dp0dist\CodexTokenStatusbar-win32-x64\CodexTokenStatusbar.exe"
)
