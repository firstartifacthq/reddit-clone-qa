/** @param {{kind: "community" | "post" | "comment", canonical_id: string, canonical_name: string | null, display_name: string | null, title: string | null, content: string | null, body: string | null}} row */
export function searchRepresentation(row) {
  if (row.kind === "community") return { type: "community", canonicalName: row.canonical_name, displayName: row.display_name };
  if (row.kind === "post") return { type: "post", id: row.canonical_id, title: row.title, content: row.content };
  return { type: "comment", id: row.canonical_id, body: row.body };
}
