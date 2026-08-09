import { assert, exactObject } from "./errors.mjs";
import { OFFICE_LIMITS } from "./limits.mjs";
import { safeText } from "./xml.mjs";
import { composeDocx } from "./docx.mjs";
import { composePptx } from "./pptx.mjs";

export function parseMarkdownOutline(markdown) {
  assert(typeof markdown === "string", "INPUT_INVALID", "Markdown must be text");
  assert(new TextEncoder().encode(markdown).byteLength <= OFFICE_LIMITS.xmlTextBytes, "INPUT_TOO_LARGE", "Markdown exceeds limit");
  assert(!markdown.includes("\0"), "INPUT_INVALID", "NUL is forbidden");
  const blocks = [];
  let paragraph = [];
  let list = [];
  let ordered = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: safeText(paragraph.join(" ").trim(), OFFICE_LIMITS.modelTextChars) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) {
      assert(list.length <= OFFICE_LIMITS.listItems, "INPUT_TOO_LARGE", "Markdown list exceeds limit");
      blocks.push({ type: "list", ordered, items: list });
    }
    list = [];
  };
  for (const raw of markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const bullet = line.match(/^\s*([-+*])\s+(.+)$/);
    const numbered = line.match(/^\s*([0-9]+)[.)]\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: safeText(heading[2].trim(), OFFICE_LIMITS.modelTextChars) });
    } else if (bullet || numbered) {
      flushParagraph();
      const nextOrdered = Boolean(numbered);
      if (list.length && ordered !== nextOrdered) flushList();
      ordered = nextOrdered;
      list.push(safeText((bullet?.[2] ?? numbered[2]).trim(), OFFICE_LIMITS.modelTextChars));
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
    assert(blocks.length + paragraph.length + list.length <= OFFICE_LIMITS.blocks, "INPUT_TOO_LARGE", "Markdown block count exceeds limit");
  }
  flushParagraph();
  flushList();
  return { blocks };
}

export function markdownOutlineToDocx(markdown, options = {}) {
  exactObject(options, ["title"]);
  const outline = parseMarkdownOutline(markdown);
  return composeDocx({ title: options.title ?? "", blocks: outline.blocks });
}

export function markdownOutlineToPptx(markdown, options = {}) {
  exactObject(options, ["title"]);
  const { blocks } = parseMarkdownOutline(markdown);
  const slides = [];
  let current;
  const ensure = () => {
    if (!current) {
      current = { title: "", bullets: [] };
      slides.push(current);
      assert(slides.length <= OFFICE_LIMITS.slides, "INPUT_TOO_LARGE", "Markdown slide count exceeds limit");
    }
    return current;
  };
  for (const block of blocks) {
    if (block.type === "heading" && block.level <= 2) {
      current = { title: block.text, bullets: [] };
      slides.push(current);
      assert(slides.length <= OFFICE_LIMITS.slides, "INPUT_TOO_LARGE", "Markdown slide count exceeds limit");
    } else if (block.type === "list") {
      ensure().bullets.push(...block.items);
    } else if (block.type === "paragraph") {
      ensure().bullets.push(block.text);
    } else if (block.type === "heading") {
      ensure().bullets.push(block.text);
    }
    if (current) assert(current.bullets.length <= OFFICE_LIMITS.slideBullets, "INPUT_TOO_LARGE", "Markdown slide bullet count exceeds limit");
  }
  return composePptx({ title: options.title ?? "", slides });
}
