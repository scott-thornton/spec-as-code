export function addBookmark(url, title) {
  const bookmark = { url, title, addedAt: new Date().toISOString() };
  store.push(bookmark);
  return { ...bookmark };
}

export function listBookmarks() {
  return store.map((b) => ({ ...b }));
}

const store = [];
