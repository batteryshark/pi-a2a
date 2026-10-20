# Pure descriptor policy, shared by the filesystem helper and native policy tests.
# TrustedInstaller is an OS role only: never a payload owner/grant exception.
function CheckDescriptor($acl, [string]$kind, $sid) {
  $payload = $kind -in @('root','file','directory')
  $evidence = $kind -in @('evidence','evidenceDirectory')
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  if (!$payload -and !$evidence) {
    $trusted += 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($payload) { if ($owner -ne $sid.Value) { throw 'owner' } }
  elseif ($evidence) { if ($owner -notin @($sid.Value, 'S-1-5-32-544')) { throw 'evidence owner' } }
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
      if ($payload -or $evidence) { throw 'deny' }
      continue
    }
    $who = $rule.IdentityReference.Value
    $inheritOnly = ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
    if ($trusted -notcontains $who) {
      # Read/traverse/create-sibling does not authorize replacing protected children.
      $danger = 0x000D0150
      if ($kind -eq 'launch') { $danger = 0x000D0156 }
      if ($payload -or $evidence -or (!$inheritOnly -and (([int]$rule.FileSystemRights -band $danger) -ne 0))) { throw 'grant' }
    }
    if ($who -eq $sid.Value -and !$inheritOnly -and (([int]$rule.FileSystemRights -band 0x1F01FF) -eq 0x1F01FF)) {
      if ($kind -notin @('root','directory') -or (($rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq 'None')) { $full = $true }
    }
  }
  if (($payload -or $evidence) -and !$full) { throw 'full control' }
}
