$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/windows-policy.ps1')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$ti = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$ordinary = 'S-1-5-32-545'
$script:count = 0
function Case([string]$owner, [string]$grant, [string]$rights, [string]$kind, [bool]$accept) {
  # In-memory genuine .NET ACLs: policy tests, NOT actual filesystem ownership.
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier ($owner)))
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule ((New-Object Security.Principal.SecurityIdentifier ($grant)), $rights, 'Allow')))
  $passed = $true
  try { CheckDescriptor $acl $kind $sid } catch { $passed = $false }
  if ($passed -ne $accept) { throw "descriptor policy case $script:count failed" }
  $script:count++
}
foreach ($kind in @('ancestor','launch')) {
  Case $ti $ti 'FullControl' $kind $true
  Case $ordinary $sid.Value 'FullControl' $kind $false
  Case $sid.Value $ordinary 'Modify' $kind $false
  Case $sid.Value $ordinary 'DeleteSubdirectoriesAndFiles' $kind $false
  Case $sid.Value $ordinary 'ReadAndExecute' $kind $true
  Case $sid.Value ($ti + '-1') 'FullControl' $kind $false
}
foreach ($kind in @('root','file','directory')) {
  Case $ti $sid.Value 'FullControl' $kind $false
  Case $sid.Value $ti 'Read' $kind $false
  Case $sid.Value $ordinary 'Read' $kind $false
  Case $sid.Value $sid.Value 'FullControl' $kind $true
}
foreach ($kind in @('evidence','evidenceDirectory')) {
  Case 'S-1-5-32-544' $sid.Value 'FullControl' $kind $true
  Case $sid.Value $ordinary 'Read' $kind $false
  Case $ti $sid.Value 'FullControl' $kind $false
  Case 'S-1-5-18' $sid.Value 'FullControl' $kind $false
  Case 'S-1-5-32-544' $ti 'Read' $kind $false
  Case $sid.Value $sid.Value 'FullControl' $kind $true
}
[Console]::Out.WriteLine("descriptor-policy passed=$script:count (not filesystem-owner proof)")
