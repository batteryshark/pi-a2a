// Security boundary seam: Windows must supply verified SID/ACL support, not chmod.
export function accountIdentity() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw Object.assign(Error('Unsupported security platform'), { code: 'UNSUPPORTED_SECURITY' });
  }
  return `posix:${process.getuid()}`;
}
