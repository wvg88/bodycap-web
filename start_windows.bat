@echo off
REM Bodycap Web starten op Windows: dubbelklik dit bestand.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 server.py %*
) else (
    python server.py %*
)
if errorlevel 1 (
    echo.
    echo Lukt het starten niet? Installeer Python 3 via https://www.python.org/downloads/
    echo en vink "Add python.exe to PATH" aan.
    pause
)
