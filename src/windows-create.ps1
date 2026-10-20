# Fixed trusted wrapper. Never repairs an ACL or changes process/token policy.
function NewPrivateDescriptor([bool]$directory, $sid) {
  if ($directory) { $d = New-Object Security.AccessControl.DirectorySecurity }
  else { $d = New-Object Security.AccessControl.FileSecurity }
  $d.SetOwner($sid)
  $d.SetAccessRuleProtection($true,$false)
  if ($directory) { $r = New-Object Security.AccessControl.FileSystemAccessRule ($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow') }
  else { $r = New-Object Security.AccessControl.FileSystemAccessRule ($sid,'FullControl','Allow') }
  $d.AddAccessRule($r)
  return $d
}
function CreatePrivateLock([string]$p, $sid) {
  # Framework C# compilation may use disk. Confine ALL compiler scratch to a
  # fresh protected leaf, never ambient Temp. Compile/clean BEFORE lock effect.
  $scratch = Join-Path ([IO.Path]::GetDirectoryName($p)) ('.helper-' + [Guid]::NewGuid().ToString())
  if (Test-Path -LiteralPath $scratch) { throw 'scratch collision' }
  [void][IO.Directory]::CreateDirectory($scratch,(NewPrivateDescriptor $true $sid))
  CheckDescriptor (Get-Acl -LiteralPath $scratch) 'root' $sid
  $cp = New-Object CodeDom.Compiler.CompilerParameters
  $cp.GenerateInMemory = $true
  $cp.TempFiles = New-Object CodeDom.Compiler.TempFileCollection ($scratch,$false)
  $oldTemp = $env:TEMP; $oldTmp = $env:TMP
  $env:TEMP = $scratch; $env:TMP = $scratch
  try {
    Add-Type -CompilerParameters $cp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrivateDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct Attributes {
    public int Length;
    public IntPtr Descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectoryW(string path, ref Attributes attributes);
  public static int Create(string path, byte[] descriptor) {
    var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      var a = new Attributes { Length=Marshal.SizeOf(typeof(Attributes)), Descriptor=pin.AddrOfPinnedObject(), Inherit=false };
      if (CreateDirectoryW(path, ref a)) return 0;
      return Marshal.GetLastWin32Error();
    } finally { pin.Free(); }
  }
}
'@
  } finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
    $cp.TempFiles.Delete()
    # Never recursively remove unknown compiler leftovers; fail before effect.
    [IO.Directory]::Delete($scratch)
  }
  return [PrivateDirectory]::Create($p,(NewPrivateDescriptor $true $sid).GetSecurityDescriptorBinaryForm())
}
