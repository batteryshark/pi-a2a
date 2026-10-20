param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/windows-policy.ps1')
if ($Path.Length -gt 240 -or $Path -notmatch '^[A-Za-z]:\\' -or $Path.Substring(2).Contains(':') -or $Path -match '[\x00-\x1f<>"|?*/]') { throw 'path' }
foreach ($part in $Path.Substring(3).Split('\')) {
  if (!$part -or $part -match '[. ]$' -or $part -match '^(?i:con|conin\$|conout\$|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(?:\.|$)') { throw 'path' }
}
if (![String]::Equals([IO.Path]::GetFullPath($Path),$Path,[StringComparison]::OrdinalIgnoreCase)) { throw 'canonical' }
if (Test-Path -LiteralPath $Path) { throw 'Parent must be a NEW leaf; never reuse/repair' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$drive = New-Object IO.DriveInfo ($Path.Substring(0,3))
if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { throw 'volume' }
$parent = [IO.Directory]::GetParent($Path)
if (!$parent.Exists) { throw 'Immediate parent must exist' }
while ($null -ne $parent) {
  $item = Get-Item -LiteralPath $parent.FullName -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  CheckDescriptor (Get-Acl -LiteralPath $parent.FullName) 'ancestor' $sid
  $parent = $parent.Parent
}
$d = New-Object Security.AccessControl.DirectorySecurity
$d.SetOwner($sid)
$d.SetAccessRuleProtection($true,$false)
$d.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')))
[void][IO.Directory]::CreateDirectory($Path,$d)
CheckDescriptor (Get-Acl -LiteralPath $Path) 'root' $sid
Write-Output 'Protected new proof parent verified; no existing ACL changed.'
