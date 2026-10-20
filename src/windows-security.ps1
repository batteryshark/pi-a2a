# Windows PowerShell 5.1 / .NET Framework. Package code is trusted by the caller.
# No exception text, identity or filesystem detail other than the internal SID
# response crosses the helper boundary. Never repairs an existing ACL.
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding ($false, $true)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding ($false)
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 2048) { throw 'limit' }
  if ($inputText.Length -gt 0 -and $inputText[0] -eq [char]0xFEFF) { $inputText = $inputText.Substring(1) }
  $q = ConvertFrom-Json $inputText
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  . (Join-Path $PSScriptRoot 'windows-policy.ps1')
  function CheckPath([string]$p) {
    if ($p.Length -gt 240 -or $p -notmatch '^[A-Za-z]:\\' -or $p.Substring(2).Contains(':') -or $p -match '[\x00-\x1f<>"|?*/]') { throw 'path' }
    foreach ($part in $p.Substring(3).Split('\')) {
      if (!$part -or $part -match '[. ]$' -or $part -match '^(?i:con|conin\$|conout\$|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(?:\.|$)') { throw 'path' }
    }
    if (![String]::Equals([IO.Path]::GetFullPath($p), $p, [StringComparison]::OrdinalIgnoreCase)) { throw 'canonical' }
    $drive = New-Object IO.DriveInfo ($p.Substring(0,3))
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { throw 'volume' }
  }
  function CheckAcl([string]$p, [string]$kind) {
    $item = Get-Item -LiteralPath $p -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $acl = Get-Acl -LiteralPath $p
    CheckDescriptor $acl $kind $sid
  }
  if ($q.op -ne 'identity') {
    if ($q.op -notin @('root','verifyRoot','inspectRoot','file','directory','launch','createFile','createLock','evidence','evidenceDirectory')) { throw 'op' }
    $p = [string]$q.path
    CheckPath $p
    $parent = [IO.Directory]::GetParent($p)
    $immediate = $true
    while ($null -ne $parent) {
      # Only the immediate Pi-owned evidence container gets the read-only role;
      # higher layout ancestors retain the ordinary safe-ancestor policy.
      $role = 'ancestor'
      if ($immediate -and $q.op -eq 'evidence') { $role = 'evidenceDirectory' }
      CheckAcl $parent.FullName $role
      $immediate = $false; $parent = $parent.Parent
    }
    if ($q.op -in @('createFile','createLock')) {
      $parentPath = [IO.Path]::GetDirectoryName($p)
      CheckAcl $parentPath 'directory'
      . (Join-Path $PSScriptRoot 'windows-create.ps1')
      if ($q.op -eq 'createLock') {
        $errorCode = CreatePrivateLock $p $sid
        if ($errorCode -eq 183) {
          [Console]::Out.Write((@{ok=$true;sid=$sid.Value;created=$false} | ConvertTo-Json -Compress))
          exit 0
        }
        if ($errorCode -ne 0) { throw 'create directory' }
        CheckAcl $p 'root'
      } else {
        $rights = [Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write
        $stream = [IO.FileStream]::new($p,[IO.FileMode]::CreateNew,$rights,[IO.FileShare]::None,4096,[IO.FileOptions]::None,(NewPrivateDescriptor $false $sid))
        try { if ($stream.Length -ne 0) { throw 'not empty' } } finally { $stream.Dispose() }
        CheckAcl $p 'file'
      }
      [Console]::Out.Write((@{ok=$true;sid=$sid.Value;created=$true} | ConvertTo-Json -Compress))
      exit 0
    }
    if ($q.op -eq 'inspectRoot' -and !(Test-Path -LiteralPath $p)) {
      [Console]::Out.Write((@{ok=$true;sid=$sid.Value} | ConvertTo-Json -Compress))
      exit 0
    }
    if ($q.op -eq 'root' -and !(Test-Path -LiteralPath $p)) {
      # Immediate parent must exist: never recursively create insecure ancestors.
      $parentPath = [IO.Path]::GetDirectoryName($p)
      if (![IO.Directory]::Exists($parentPath)) { throw 'parent' }
      $d = New-Object Security.AccessControl.DirectorySecurity
      $d.SetOwner($sid)
      $d.SetAccessRuleProtection($true,$false)
      $r = New-Object Security.AccessControl.FileSystemAccessRule ($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      $d.AddAccessRule($r)
      [void][IO.Directory]::CreateDirectory($p,$d)
    }
    $kind = $q.op
    if ($kind -in @('root','verifyRoot','inspectRoot')) { $kind = 'root' }
    CheckAcl $p $kind
    $item = Get-Item -LiteralPath $p -Force
    if ($kind -in @('root','directory','evidenceDirectory') -and !$item.PSIsContainer) { throw 'type' }
    if ($kind -in @('file','launch','evidence') -and $item.PSIsContainer) { throw 'type' }
  }
  [Console]::Out.Write((@{ok=$true;sid=$sid.Value} | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 3
}
