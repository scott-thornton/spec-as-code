export function hash(s) {
  let h = 0;
  for (const c of s) {
    h = (h * 31 + c.charCodeAt(0)) | 0;
  }
  return String(h);
}
