param([string]$Root,[ValidateSet('creation','evidence','reader')][string]$Mode)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/windows-policy.ps1')
. (Join-Path $PSScriptRoot '../src/windows-create.ps1')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$helper = Join-Path $PSScriptRoot '../src/windows-security.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Call([string]$op,[string]$p,[int]$status=0) {
  $out = @{op=$op;path=$p} | ConvertTo-Json -Compress | & $ps -NoLogo -NoProfile -NonInteractive -File $helper
  if ($LASTEXITCODE -ne $status) { throw 'helper result mismatch' }
  return ($out | ConvertFrom-Json)
}
[void](Call 'verifyRoot' $Root)
if ($Mode -eq 'creation') {
  $p = Join-Path $Root 'exclusive-empty'
  if (!(Call 'createFile' $p).created) { throw 'no creation acknowledgment' }
  $a = Get-Acl -LiteralPath $p
  if (!$a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or (Get-Item -LiteralPath $p).Length -ne 0) { throw 'file descriptor/empty' }
  $before = $a.Sddl
  [void](Call 'createFile' $p 3)
  if ((Get-Acl -LiteralPath $p).Sddl -ne $before -or (Get-Item -LiteralPath $p).Length -ne 0) { throw 'existing file changed' }
  $lock = Join-Path $Root 'exclusive-lock'
  if (!(Call 'createLock' $lock).created) { throw 'lock not acquired' }
  if ((Call 'createLock' $lock).created) { throw 'existing lock acquired twice' }
  CheckDescriptor (Get-Acl -LiteralPath $lock) 'root' $sid
  [void](Call 'createFile' (Join-Path $lock 'owner'))
  CheckDescriptor (Get-Acl -LiteralPath (Join-Path $lock 'owner')) 'file' $sid
} elseif ($Mode -eq 'reader') {
  $p = Join-Path $Root 'synthetic-reader-negative'
  $d = NewPrivateDescriptor $false $sid
  $d.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ((New-Object Security.Principal.SecurityIdentifier ('S-1-5-32-545')),'Read','Allow')))
  $rights = [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write
  $s = [IO.FileStream]::new($p,[IO.FileMode]::CreateNew,$rights,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$d)
  $s.Dispose()
  $before = (Get-Acl -LiteralPath $p).Sddl
  [void](Call 'evidence' $p 3)
  [void](Call 'file' $p 3)
  if ((Get-Acl -LiteralPath $p).Sddl -ne $before) { throw 'reader fixture changed' }
} else {
  $admin = New-Object Security.Principal.SecurityIdentifier ('S-1-5-32-544')
  $container = Join-Path $Root 'synthetic-evidence-container'
  $d = NewPrivateDescriptor $true $sid
  $d.SetOwner($admin)
  try { [void][IO.Directory]::CreateDirectory($container,$d) } catch { Write-Output 'Admin-owner fixture unavailable'; exit 77 }
  [void](Call 'evidenceDirectory' $container)
  [void](Call 'directory' $container 3)
  foreach ($ordinary in @($false,$true)) {
    $p = Join-Path $container ('synthetic-empty-' + $ordinary)
    $d = NewPrivateDescriptor $false $sid
    $d.SetOwner($admin)
    if ($ordinary) { $d.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ((New-Object Security.Principal.SecurityIdentifier ('S-1-5-32-545')),'Read','Allow'))) }
    $rights = [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write
    $s = [IO.FileStream]::new($p,[IO.FileMode]::CreateNew,$rights,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$d)
    $s.Dispose()
    $before = (Get-Acl -LiteralPath $p).Sddl
    if ($ordinary) { [void](Call 'evidence' $p 3) } else { [void](Call 'evidence' $p) }
    [void](Call 'file' $p 3)
    if ((Get-Acl -LiteralPath $p).Sddl -ne $before -or (Get-Item -LiteralPath $p).Length -ne 0) { throw 'evidence changed' }
  }
}
Write-Output 'native-fixtures passed (synthetic owned files, not Pi writer proof)'
