# Builds ..\KrakenBridge.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw ".NET Framework 4 compiler not found at $csc" }
$out = Join-Path $PSScriptRoot '..\KrakenBridge.exe'
& $csc /nologo /target:winexe /optimize+ /out:$out `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Security.dll `
    /r:System.Management.dll /r:System.Web.Extensions.dll `
    (Join-Path $PSScriptRoot 'KrakenTray.cs')
if ($LASTEXITCODE -ne 0) { throw "build failed" }
"Built $((Resolve-Path $out).Path)"
