@echo off
rem Launcher for scheduled task "HyperliquidAlertWatcher".
rem Stdout/stderr go to .alerts\watch.log (ignored by .gitignore *.log).
rem Keep this file ASCII-only: cmd.exe parses it in the OEM codepage (GBK here).
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" tools\watch.js --user 0x8056D1a3f8591B03Bb1988136eb49CED066C554E > ".alerts\watch.log" 2>&1
