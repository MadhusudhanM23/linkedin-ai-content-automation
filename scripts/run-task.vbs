' Launches the per-minute check with no console window.
' Resolves its own folder, so the project can be moved or copied to another
' machine without editing this file.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & fso.BuildPath(scriptDir, "run-task.cmd") & """", 0, False
