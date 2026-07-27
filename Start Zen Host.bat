@echo off
cd /d "%~dp0"
echo Starting Zen Host...
node_modules\electron\dist\electron.exe .
