export function link(params) {
  let q = "";
  for (const [k, v] of Object.entries(params)) {
    q += (q ? "&" : "") + k + "=" + v;
  }
  return "https://example.test/?" + q;
}
