# Windows PowerShell 5.1 / .NET Framework. Package code is trusted by the caller.
# No exception text, identity or filesystem detail other than the internal SID
# response crosses the helper boundary. Never repairs an existing ACL.
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding ($false, $true)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding ($false)
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 2048) { throw 'limit' }
  $q = ConvertFrom-Json $inputText
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
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
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($kind -in @('root','file','directory')) { if ($owner -ne $sid.Value) { throw 'owner' } }
    elseif ($trusted -notcontains $owner) { throw 'ancestor owner' }
    $raw = New-Object Security.AccessControl.RawSecurityDescriptor ($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -eq 0) { throw 'dacl' }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed, [Security.AccessControl.AceType]::AccessDenied)) { throw 'unknown ace' }
    }
    if ($kind -eq 'root' -and !$acl.AreAccessRulesProtected) { throw 'unprotected' }
    $full = $false
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Deny') {
        if ($kind -ne 'ancestor' -and $kind -ne 'launch') { throw 'deny' }
        continue
      }
      $who = $rule.IdentityReference.Value
      $inheritOnly = ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
      if ($trusted -notcontains $who) {
        # Ancestor read/traverse and create-sibling rights do not permit replacing
        # an existing protected child. Delete-child/ACL/owner/write-attribute do.
        $danger = 0x000D0150
        if ($kind -eq 'launch') { $danger = 0x000D0156 }
        if ($kind -in @('root','file','directory') -or (!$inheritOnly -and (([int]$rule.FileSystemRights -band $danger) -ne 0))) { throw 'grant' }
      }
      if ($who -eq $sid.Value -and !$inheritOnly -and (([int]$rule.FileSystemRights -band 0x1F01FF) -eq 0x1F01FF)) {
        if ($kind -notin @('root','directory') -or (($rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq 'None')) { $full = $true }
      }
    }
    if ($kind -in @('root','file','directory') -and !$full) { throw 'full control' }
  }
  if ($q.op -ne 'identity') {
    if ($q.op -notin @('root','verifyRoot','inspectRoot','file','directory','launch')) { throw 'op' }
    $p = [string]$q.path
    CheckPath $p
    $parent = [IO.Directory]::GetParent($p)
    while ($null -ne $parent) { CheckAcl $parent.FullName 'ancestor'; $parent = $parent.Parent }
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
    if ($kind -in @('root','directory') -and !$item.PSIsContainer) { throw 'type' }
    if ($kind -in @('file','launch') -and $item.PSIsContainer) { throw 'type' }
  }
  [Console]::Out.Write((@{ok=$true;sid=$sid.Value} | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 3
}
