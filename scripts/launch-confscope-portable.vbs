Option Explicit

Dim shell, env
Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("Process")
env("CONFSCOPE_DATA_DIR") = "C:\Users\adsry\myworkspace\Personal\Git\ConfScope\portable\ConfScopeData"
shell.Run """C:\Users\adsry\myworkspace\Personal\Git\ConfScope\build\bin\ConfScope.exe""", 1, False
