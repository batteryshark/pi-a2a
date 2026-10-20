param([string]$Root)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/windows-policy.ps1')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
CheckDescriptor (Get-Acl -LiteralPath $Root) 'root' $sid
$ordinary = New-Object Security.Principal.SecurityIdentifier ('S-1-5-32-545')
$count = 0
foreach ($rights in @('ReadAndExecute','Modify','DeleteSubdirectoriesAndFiles')) {
  $p = Join-Path $Root ('negative-' + $count)
  $d = New-Object Security.AccessControl.DirectorySecurity
  $d.SetOwner($sid)
  $d.SetAccessRuleProtection($true,$false)
  $d.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')))
  $d.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ($ordinary,$rights,'Allow')))
  [void][IO.Directory]::CreateDirectory($p,$d)
  $rejected = $false
  try { CheckDescriptor (Get-Acl -LiteralPath $p) 'root' $sid } catch { $rejected = $true }
  if (!$rejected) { throw 'unsafe grant accepted' }
  # The real helper must also reject, without changing bytes/ACLs.
  $before = (Get-Acl -LiteralPath $p).Sddl
  @{op='verifyRoot';path=$p} | ConvertTo-Json -Compress | & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot '../src/windows-security.ps1')
  if ($LASTEXITCODE -ne 3 -or (Get-Acl -LiteralPath $p).Sddl -ne $before) { throw 'helper negative/verify-only failed' }
  $count++
}
# Owned junction needs no symbolic-link privilege; target is our empty directory.
$target = Join-Path $Root 'junction-target'
[void][IO.Directory]::CreateDirectory($target)
$junction = Join-Path $Root 'junction'
[void](New-Item -ItemType Junction -Path $junction -Target $target)
@{op='directory';path=$junction} | ConvertTo-Json -Compress | & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot '../src/windows-security.ps1')
if ($LASTEXITCODE -ne 3) { throw 'junction accepted' }
[IO.Directory]::Delete($junction)
$count++
# Exercise actual TrustedInstaller-owned OS launch/ancestors, verify-only.
$launch = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
CheckDescriptor (Get-Acl -LiteralPath $launch) 'launch' $sid
$count++
[Console]::Out.WriteLine("filesystem-negatives passed=$count")
exit 0
