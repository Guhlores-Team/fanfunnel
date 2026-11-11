// WF-11: the readable body of our own Terms / Privacy page, for the sheet
// over the age gate. The page is fetched from this origin and its <main> is
// shown in place (the site's CSP forbids frames, `frame-src 'none'`, so an
// iframe is not an option and the policy is not loosened for this). Although
// the source is our own static page, nothing executable is carried over:
// scripts, styles, frames, forms, event handlers and inline styles are
// dropped, ids are removed (no duplicates in the host page) and links open in
// a new tab so the gate underneath keeps its ticks.

const DROP = "script, style, link, meta, iframe, object, embed, form, noscript, template, nav, footer, svg[onload]";
const SAFE_HREF = /^(?:\/(?!\/)|https:\/\/|mailto:)/i;

/** The sanitised inner HTML of the document's <main>, or null when there is none. */
export function legalBody(doc: Document): string | null {
  const main = doc.querySelector("main");
  if (!main) return null;
  for (const el of Array.from(main.querySelectorAll(DROP))) el.remove();
  for (const el of Array.from(main.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || attr.name === "style" || attr.name === "id" || attr.name === "srcdoc") el.removeAttribute(attr.name);
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (SAFE_HREF.test(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      } else {
        el.removeAttribute("href");
      }
    }
  }
  return main.innerHTML;
}
