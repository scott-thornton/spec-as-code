export function slug(s) {
  return s
    .normalize("NFKD")
    .replace(/[\p{Diacritic}]/gu, "")
    .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
