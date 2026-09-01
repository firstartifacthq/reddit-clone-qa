/** @param {{id: string, community_name: string, username: string, type: "text" | "link" | "media", title: string, text_content: string | null, url_content: string | null, media_filename: string | null, media_content_type: string | null, media_bytes: Uint8Array | null}} post */
export function postRepresentation(post) {
  const common = { id: post.id, community: post.community_name, author: post.username, type: post.type, title: post.title };
  if (post.type === "text") return { ...common, text: post.text_content };
  if (post.type === "link") return { ...common, url: post.url_content };
  return { ...common, media: { filename: post.media_filename, contentType: post.media_content_type, byteLength: post.media_bytes?.length ?? 0 } };
}
