@echo off
cd /d %~dp0
if not exist node_modules call npm install
if not exist vendor\three.min.js call npm install
if not exist vendor\three.min.js node scripts\vendor.js
call npm start
