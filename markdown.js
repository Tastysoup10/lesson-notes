// Just enough Markdown for the AI summary: headings, bullet and numbered lists, paragraphs, **bold**, *italic* and
// `code`. Everything is HTML-escaped first, so nothing in the reply can add its own HTML.
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s) {
  return escape(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
}

export function markdownToHtml(text) {
  const out = [];
  let list = null; // "ul" or "ol" while inside a list
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push("<p>" + paragraph.map(inline).join("<br>") + "</p>");
    paragraph = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      closeList();
      const level = Math.min(m[1].length + 1, 4); // # becomes h2: the page already has its h1
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/))) {
      flush();
      const kind = m[1] ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(m[2])}</li>`);
    } else if (line.trim() === "" || /^-{3,}$/.test(line.trim())) {
      flush();
      closeList();
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flush();
  closeList();
  return out.join("\n");
}
