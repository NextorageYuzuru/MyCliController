# Creates a "Claude CLI Controller" shortcut on the desktop and in the Start menu.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude CLI Controller.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude CLI Controller.lnk')
)
foreach ($t in $targets) {
  $s = $ws.CreateShortcut($t)
  $s.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $s.Arguments = '"' + (Join-Path $dir 'start.vbs') + '"'
  $s.WorkingDirectory = $dir
  $s.IconLocation = (Join-Path $dir 'public\icon.ico') + ',0'
  $s.Description = 'Claude CLI Controller'
  $s.Save()
  Write-Output "Created: $t"
}
