' Starts kraken-bridge.js with no console window.
' Used by install-startup.ps1; can also be double-clicked.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & here & "\kraken-bridge.js""", 0, False
