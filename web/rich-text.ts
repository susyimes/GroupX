/**
 * Lightweight rich-text rendering for agent messages.
 *
 * Dependency-free and CSP-safe: everything is built with createElement /
 * textContent, never innerHTML. The parsing layer is pure (segmentRichText /
 * segmentInline) so it can be unit-tested in node; renderRichContent is only
 * a thin DOM mapping over those segments.
 */

export interface RichTextSegment {
  readonly kind: "text";
  readonly text: string;
}

export interface RichCodeSegment {
  readonly kind: "code";
  readonly language: string;
  readonly code: string;
}

export type RichSegment = RichTextSegment | RichCodeSegment;

export type InlinePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

const FENCE_OPEN_PATTERN = /^```([^\s`]*)\s*$/;
const FENCE_CLOSE = "```";
const LANGUAGE_PATTERN = /^[A-Za-z0-9+#._-]{1,24}$/;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const RAW_URL_STOP_PATTERN = /[\s<>"'`\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F]/u;

function sanitizeLanguage(raw: string): string {
  return LANGUAGE_PATTERN.test(raw) ? raw : "";
}

/**
 * Split a message into plain-text and fenced-code segments. An unclosed fence
 * (common while a turn is still streaming) treats the rest of the text as
 * code instead of dropping it.
 */
export function segmentRichText(text: string): RichSegment[] {
  const segments: RichSegment[] = [];
  const lines = text.split("\n");
  let plain: string[] = [];

  const flushPlain = (): void => {
    if (plain.length === 0) {
      return;
    }
    const value = plain.join("\n");
    plain = [];
    if (value.length > 0) {
      segments.push({ kind: "text", text: value });
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const open = FENCE_OPEN_PATTERN.exec(line.trimEnd());
    if (!open) {
      plain.push(line);
      index += 1;
      continue;
    }

    flushPlain();
    const language = sanitizeLanguage(open[1] ?? "");
    const codeLines: string[] = [];
    index += 1;
    let closed = false;
    while (index < lines.length) {
      const codeLine = lines[index] ?? "";
      if (codeLine.trim() === FENCE_CLOSE) {
        closed = true;
        index += 1;
        break;
      }
      codeLines.push(codeLine);
      index += 1;
    }
    void closed; // unclosed fences simply run to the end of the text
    segments.push({ kind: "code", language, code: codeLines.join("\n") });
  }
  flushPlain();
  return segments;
}

/** Trim punctuation that commonly follows a URL in prose but is not part of it. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"<>`\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\u201C\u201D\u2018\u2019\uFF08\uFF09\u3010\u3011\u300A\u300B]+$/u, "");
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  for (const [open, close] of pairs) {
    while (url.endsWith(close)) {
      const opens = url.split(open).length - 1;
      const closes = url.split(close).length - 1;
      if (closes <= opens) {
        break;
      }
      url = url.slice(0, -1);
    }
  }
  return url;
}

interface ParsedMarkdownLink {
  readonly end: number;
  readonly href: string;
  readonly label: string;
}

function parseMarkdownLinkAt(text: string, start: number): ParsedMarkdownLink | undefined {
  if (text[start] !== "[") {
    return undefined;
  }
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd <= start + 1 || text.slice(start + 1, labelEnd).includes("\n")) {
    return undefined;
  }
  const urlStart = labelEnd + 2;
  if (!text.startsWith("http://", urlStart) && !text.startsWith("https://", urlStart)) {
    return undefined;
  }

  let parenthesisDepth = 0;
  for (let cursor = urlStart; cursor < text.length; cursor += 1) {
    const character = text[cursor] ?? "";
    if (RAW_URL_STOP_PATTERN.test(character)) {
      return undefined;
    }
    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }
    if (parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      continue;
    }
    const href = text.slice(urlStart, cursor);
    return href.length === 0
      ? undefined
      : { end: cursor + 1, href, label: text.slice(start + 1, labelEnd) };
  }
  return undefined;
}

function rawUrlEnd(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && !RAW_URL_STOP_PATTERN.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function segmentLinks(text: string, output: InlinePart[]): void {
  let cursor = 0;
  let plainStart = 0;
  while (cursor < text.length) {
    const markdown = parseMarkdownLinkAt(text, cursor);
    if (markdown !== undefined) {
      if (cursor > plainStart) {
        output.push({ kind: "text", text: text.slice(plainStart, cursor) });
      }
      output.push({ kind: "link", text: markdown.label, href: markdown.href });
      cursor = markdown.end;
      plainStart = cursor;
      continue;
    }

    const isRawUrl = text.startsWith("http://", cursor) || text.startsWith("https://", cursor);
    if (!isRawUrl) {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) {
      output.push({ kind: "text", text: text.slice(plainStart, cursor) });
    }
    const end = rawUrlEnd(text, cursor);
    const raw = text.slice(cursor, end);
    const href = trimUrl(raw);
    if (href.length > 0) {
      output.push({ kind: "link", text: href, href });
      if (href.length < raw.length) {
        output.push({ kind: "text", text: raw.slice(href.length) });
      }
    } else {
      output.push({ kind: "text", text: raw });
    }
    cursor = end;
    plainStart = cursor;
  }
  if (plainStart < text.length) {
    output.push({ kind: "text", text: text.slice(plainStart) });
  }
}

/**
 * Split a plain-text segment into inline parts: `code` spans and http/https
 * links. URLs inside backtick spans stay literal. Only http/https is linked,
 * so schemes like javascript: can never become anchors.
 */
export function segmentInline(text: string): InlinePart[] {
  const output: InlinePart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segmentLinks(text.slice(cursor, start), output);
    }
    output.push({ kind: "code", text: match[1] ?? "" });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    segmentLinks(text.slice(cursor), output);
  }
  return output;
}

/** Copy text to the clipboard; resolves to whether the copy succeeded. */
export async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "true");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Flash a transient label on a button (e.g. "已复制"), then restore it. */
export function flashButtonLabel(button: HTMLButtonElement, label: string, restoreMs = 1_200): void {
  const original = button.textContent ?? "";
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
  }, restoreMs);
}

function createCodeBlock(segment: RichCodeSegment): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";

  const header = document.createElement("div");
  header.className = "code-block-header";
  const language = document.createElement("span");
  language.className = "code-lang";
  language.textContent = segment.language || "code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-copy";
  copy.textContent = "复制";
  copy.addEventListener("click", () => {
    void copyPlainText(segment.code).then((ok) => {
      flashButtonLabel(copy, ok ? "已复制" : "复制失败");
    });
  });
  header.append(language, copy);

  const pre = document.createElement("pre");
  pre.className = "code-block-body";
  const code = document.createElement("code");
  code.textContent = segment.code;
  pre.append(code);
  wrapper.append(header, pre);
  return wrapper;
}

function appendInlineParts(container: HTMLElement, text: string): void {
  for (const part of segmentInline(text)) {
    if (part.kind === "code") {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = part.text;
      container.append(code);
    } else if (part.kind === "link") {
      const link = document.createElement("a");
      link.className = "inline-link";
      link.href = part.href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.textContent = part.text;
      container.append(link);
    } else {
      container.append(document.createTextNode(part.text));
    }
  }
}

/**
 * Render message text into a container. The container keeps its pre-wrap
 * whitespace handling; fenced code becomes block-level code blocks with a
 * language label and copy button.
 */
export function renderRichContent(container: HTMLElement, text: string): void {
  container.replaceChildren();
  for (const segment of segmentRichText(text)) {
    if (segment.kind === "code") {
      container.append(createCodeBlock(segment));
    } else {
      appendInlineParts(container, segment.text);
    }
  }
}
