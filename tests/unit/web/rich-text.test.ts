import { describe, expect, it } from "vitest";

import { segmentInline, segmentRichText } from "../../../web/rich-text.js";

describe("segmentRichText", () => {
  it("passes plain text through as a single segment", () => {
    expect(segmentRichText("hello\nworld")).toEqual([{ kind: "text", text: "hello\nworld" }]);
  });

  it("extracts a fenced code block with its language", () => {
    expect(segmentRichText("before\n```ts\nconst a = 1;\n```\nafter")).toEqual([
      { kind: "text", text: "before" },
      { kind: "code", language: "ts", code: "const a = 1;" },
      { kind: "text", text: "after" },
    ]);
  });

  it("defaults the language label for bare fences", () => {
    expect(segmentRichText("```\nplain code\n```")).toEqual([
      { kind: "code", language: "", code: "plain code" },
    ]);
  });

  it("treats an unclosed fence as code until the end", () => {
    expect(segmentRichText("intro\n```json\n{\"a\": 1}\nstill code")).toEqual([
      { kind: "text", text: "intro" },
      { kind: "code", language: "json", code: "{\"a\": 1}\nstill code" },
    ]);
  });

  it("handles multiple fenced blocks and empty code bodies", () => {
    expect(segmentRichText("```sh\nls\n```\nmiddle\n```\n```")).toEqual([
      { kind: "code", language: "sh", code: "ls" },
      { kind: "text", text: "middle" },
      { kind: "code", language: "", code: "" },
    ]);
  });

  it("rejects unsafe language info strings", () => {
    const segments = segmentRichText("```ts;alert(1)\nx\n```");
    expect(segments).toEqual([{ kind: "code", language: "", code: "x" }]);
  });
});

describe("segmentInline", () => {
  it("returns plain text unchanged", () => {
    expect(segmentInline("no markup here")).toEqual([{ kind: "text", text: "no markup here" }]);
  });

  it("extracts inline code spans", () => {
    expect(segmentInline("run `npm test` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " now" },
    ]);
  });

  it("linkifies http/https URLs and trims trailing punctuation", () => {
    expect(segmentInline("see https://example.com/a,b.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://example.com/a,b", href: "https://example.com/a,b" },
      { kind: "text", text: "." },
    ]);
  });

  it("trims unbalanced closing brackets from URLs", () => {
    expect(segmentInline("(https://example.com/x))")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
      { kind: "text", text: "))" },
    ]);
    expect(segmentInline("https://example.com/a_(b) end")).toEqual([
      { kind: "link", text: "https://example.com/a_(b)", href: "https://example.com/a_(b)" },
      { kind: "text", text: " end" },
    ]);
  });

  it("trims CJK punctuation following URLs", () => {
    expect(segmentInline("见 https://example.com/docs。")).toEqual([
      { kind: "text", text: "见 " },
      { kind: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
      { kind: "text", text: "。" },
    ]);
  });

  it("parses adjacent Markdown links without merging their destinations", () => {
    expect(
      segmentInline(
        "预报：[Timeanddate](https://www.timeanddate.com/weather/china/beijing/ext)、[AccuWeather](https://www.accuweather.com/zh/cn/beijing/101924/weather-forecast/1812_poi)。"
      )
    ).toEqual([
      { kind: "text", text: "预报：" },
      {
        kind: "link",
        text: "Timeanddate",
        href: "https://www.timeanddate.com/weather/china/beijing/ext",
      },
      { kind: "text", text: "、" },
      {
        kind: "link",
        text: "AccuWeather",
        href: "https://www.accuweather.com/zh/cn/beijing/101924/weather-forecast/1812_poi",
      },
      { kind: "text", text: "。" },
    ]);
  });

  it("keeps balanced parentheses inside Markdown-link URLs", () => {
    expect(segmentInline("[docs](https://example.com/a_(b)) end")).toEqual([
      { kind: "link", text: "docs", href: "https://example.com/a_(b)" },
      { kind: "text", text: " end" },
    ]);
  });

  it("keeps URLs inside inline code literal", () => {
    expect(segmentInline("`https://example.com`")).toEqual([
      { kind: "code", text: "https://example.com" },
    ]);
  });

  it("never linkifies non-http schemes", () => {
    expect(segmentInline("javascript:alert(1) stays text")).toEqual([
      { kind: "text", text: "javascript:alert(1) stays text" },
    ]);
  });

  it("keeps markup-looking text as literal text", () => {
    expect(segmentInline("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});
