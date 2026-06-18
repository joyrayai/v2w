import fs from "node:fs";
import path from "node:path";
import { AlignmentType, Document, HeadingLevel, LineRuleType, Packer, Paragraph, TextRun } from "docx";
import { OUTPUT_DIR } from "../config.js";
import { safeName } from "../utils.js";

const FONT_SIZE_MAP = {
  "初号": 42,
  "小初": 36,
  "一号": 26,
  "小一": 24,
  "二号": 22,
  "小二": 18,
  "三号": 16,
  "小三": 15,
  "四号": 14,
  "小四": 12,
  "五号": 10.5,
  "小五": 9,
  "六号": 7.5
};

function sizeToHalfPoints(size) {
  if (!size) return undefined;
  const normalized = String(size).trim();
  const mapped = FONT_SIZE_MAP[normalized];
  if (mapped) return Math.round(mapped * 2);
  const number = Number(normalized.replace(/磅|pt/gi, ""));
  return Number.isFinite(number) && number > 0 ? Math.round(number * 2) : undefined;
}

function parseLineRuleTwips(text) {
  const value = String(text || "");
  const fixed = value.match(/(?:固定值|行间距)[^\d]*(\d+(?:\.\d+)?)(?:\s*[-~至到]\s*(\d+(?:\.\d+)?))?/);
  if (!fixed) return undefined;
  const start = Number(fixed[1]);
  const end = Number(fixed[2] || fixed[1]);
  const points = Number.isFinite(end) ? Math.round((start + end) / 2) : start;
  return Number.isFinite(points) && points > 0 ? Math.round(points * 20) : undefined;
}

function parseStyleLine(text, aliases) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((item) => aliases.some((alias) => item.includes(alias)));
  if (!line) return {};
  const font = line.match(/(宋体|黑体|楷体|仿宋|微软雅黑|思源黑体|华文中宋)/)?.[1];
  const size = line.match(/(初号|小初|小一|小二|小三|小四|小五|一号|二号|三号|四号|五号|六号|\d+(?:\.\d+)?\s*(?:磅|pt)?)/i)?.[1];
  const bold = /不加粗/.test(line) ? false : /加粗|bold/i.test(line) ? true : undefined;
  return {
    font,
    size: sizeToHalfPoints(size),
    bold
  };
}

function parseDocxFormatRequirement(formatRequirement) {
  const text = String(formatRequirement || "");
  const lineTwips = parseLineRuleTwips(text);
  const body = parseStyleLine(text, ["正文"]);
  return {
    headings: {
      1: parseStyleLine(text, ["一级标题", "一号标题", "标题1"]),
      2: parseStyleLine(text, ["二级标题", "二号标题", "标题2"]),
      3: parseStyleLine(text, ["三级标题", "三号标题", "标题3"])
    },
    body,
    paragraph: {
      line: lineTwips,
      firstLine: /首行缩进\s*2|首行缩进二|缩进\s*2\s*个字/.test(text) ? 560 : undefined,
      alignment: /两端对齐/.test(text) ? AlignmentType.JUSTIFIED : undefined
    }
  };
}

function mergeDefined(base = {}, override = {}) {
  const merged = { ...base };
  Object.entries(override || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  });
  return merged;
}

function parseStructuredDocument(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function alignmentFromValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["center", "centre", "居中"].includes(normalized)) return AlignmentType.CENTER;
  if (["right", "右对齐"].includes(normalized)) return AlignmentType.RIGHT;
  if (["justify", "justified", "两端对齐"].includes(normalized)) return AlignmentType.JUSTIFIED;
  if (["left", "左对齐"].includes(normalized)) return AlignmentType.LEFT;
  return undefined;
}

function normalizeStructuredTextStyle(style = {}) {
  const sizePt = Number(style.sizePt ?? style.fontSizePt);
  return {
    font: typeof style.font === "string" ? style.font.trim() : undefined,
    size: Number.isFinite(sizePt) && sizePt > 0 ? Math.round(sizePt * 2) : sizeToHalfPoints(style.size || style.fontSize),
    bold: typeof style.bold === "boolean" ? style.bold : undefined
  };
}

function normalizeStructuredParagraphStyle(style = {}) {
  const lineSpacingPt = Number(style.lineSpacingPt ?? style.lineHeightPt);
  const firstLineIndentChars = Number(style.firstLineIndentChars ?? style.firstLineChars);
  return {
    line: Number.isFinite(lineSpacingPt) && lineSpacingPt > 0 ? Math.round(lineSpacingPt * 20) : undefined,
    firstLine: Number.isFinite(firstLineIndentChars) && firstLineIndentChars > 0
      ? Math.round(firstLineIndentChars * 280)
      : undefined,
    alignment: alignmentFromValue(style.align || style.alignment)
  };
}

function fallbackTextStyle(format, key) {
  if (key === "h1") return format.headings?.[1] || {};
  if (key === "h2") return format.headings?.[2] || {};
  if (key === "h3") return format.headings?.[3] || {};
  return format.body || {};
}

function resolveStructuredStyle(structuredStyles = {}, format = {}, key = "body") {
  const source = structuredStyles?.[key] || structuredStyles?.body || {};
  return {
    text: mergeDefined(fallbackTextStyle(format, key), normalizeStructuredTextStyle(source)),
    paragraph: mergeDefined(format.paragraph || {}, normalizeStructuredParagraphStyle(source))
  };
}

function textRun(text, style = {}) {
  return new TextRun({
    text,
    font: style.font,
    size: style.size,
    bold: style.bold
  });
}

function paragraphOptionsFromStyle(style = {}) {
  const paragraph = style.paragraph || {};
  return {
    spacing: paragraph.line ? { line: paragraph.line, lineRule: LineRuleType.EXACT } : undefined,
    indent: paragraph.firstLine ? { firstLine: paragraph.firstLine } : undefined,
    alignment: paragraph.alignment
  };
}

function paragraphOptions(format) {
  const paragraph = format?.paragraph || {};
  return {
    spacing: paragraph.line ? { line: paragraph.line, lineRule: LineRuleType.EXACT } : undefined,
    indent: paragraph.firstLine ? { firstLine: paragraph.firstLine } : undefined,
    alignment: paragraph.alignment
  };
}

function structuredBlockText(block) {
  return String(block?.text ?? block?.content ?? "").trim();
}

function structuredToDocxParagraphs(document, format = {}) {
  const structuredStyles = document.styles || {};
  const blocks = document.blocks.flatMap((block) => {
    const rawType = String(block?.type || "p").trim().toLowerCase();
    const items = Array.isArray(block?.items) ? block.items : null;
    if (!items) return [block];
    const listType = rawType.includes("number") ? "numbered" : "bullet";
    return items.map((item) => ({
      type: listType,
      text: String(item?.text ?? item ?? "").trim()
    }));
  });
  let numberedIndex = 0;
  return blocks.map((block) => {
    const rawType = String(block?.type || "p").trim().toLowerCase();
    const text = structuredBlockText(block);
    if (!text) return new Paragraph("");
    if (["h1", "heading1", "title"].includes(rawType)) {
      const style = resolveStructuredStyle(structuredStyles, format, "h1");
      return new Paragraph({
        ...paragraphOptionsFromStyle(style),
        heading: HeadingLevel.HEADING_1,
        children: [textRun(text, style.text)]
      });
    }
    if (["h2", "heading2"].includes(rawType)) {
      const style = resolveStructuredStyle(structuredStyles, format, "h2");
      return new Paragraph({
        ...paragraphOptionsFromStyle(style),
        heading: HeadingLevel.HEADING_2,
        children: [textRun(text, style.text)]
      });
    }
    if (["h3", "heading3"].includes(rawType)) {
      const style = resolveStructuredStyle(structuredStyles, format, "h3");
      return new Paragraph({
        ...paragraphOptionsFromStyle(style),
        heading: HeadingLevel.HEADING_3,
        children: [textRun(text, style.text)]
      });
    }

    const style = resolveStructuredStyle(structuredStyles, format, "body");
    if (["bullet", "ul", "li"].includes(rawType)) {
      return new Paragraph({
        ...paragraphOptionsFromStyle(style),
        bullet: { level: 0 },
        children: [textRun(text, style.text)]
      });
    }
    if (["numbered", "ol"].includes(rawType)) {
      numberedIndex += 1;
      return new Paragraph({
        ...paragraphOptionsFromStyle(style),
        children: [textRun(`${numberedIndex}. ${text}`, style.text)]
      });
    }
    return new Paragraph({
      ...paragraphOptionsFromStyle(style),
      children: [textRun(text, style.text)]
    });
  });
}

function markdownToDocxParagraphs(markdown, format = {}) {
  return String(markdown || "").split(/\n+/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return new Paragraph("");
    const marker = trimmed.match(/^\[(H1|H2|H3|P)\]\s*(.+)$/i);
    if (marker) {
      const type = marker[1].toUpperCase();
      const text = marker[2].trim();
      if (type === "H1") {
        return new Paragraph({
          ...paragraphOptions(format),
          heading: HeadingLevel.HEADING_1,
          children: [textRun(text, format.headings?.[1])]
        });
      }
      if (type === "H2") {
        return new Paragraph({
          ...paragraphOptions(format),
          heading: HeadingLevel.HEADING_2,
          children: [textRun(text, format.headings?.[2])]
        });
      }
      if (type === "H3") {
        return new Paragraph({
          ...paragraphOptions(format),
          heading: HeadingLevel.HEADING_3,
          children: [textRun(text, format.headings?.[3])]
        });
      }
      return new Paragraph({
        ...paragraphOptions(format),
        children: [textRun(text, format.body)]
      });
    }
    if (trimmed.startsWith("### ")) {
      return new Paragraph({
        ...paragraphOptions(format),
        heading: HeadingLevel.HEADING_3,
        children: [textRun(trimmed.slice(4), format.headings?.[3])]
      });
    }
    if (trimmed.startsWith("## ")) {
      return new Paragraph({
        ...paragraphOptions(format),
        heading: HeadingLevel.HEADING_2,
        children: [textRun(trimmed.slice(3), format.headings?.[2])]
      });
    }
    if (trimmed.startsWith("# ")) {
      return new Paragraph({
        ...paragraphOptions(format),
        heading: HeadingLevel.HEADING_1,
        children: [textRun(trimmed.slice(2), format.headings?.[1])]
      });
    }
    if (/^[-*]\s+/.test(trimmed)) {
      return new Paragraph({
        ...paragraphOptions(format),
        bullet: { level: 0 },
        children: [textRun(trimmed.replace(/^[-*]\s+/, ""), format.body)]
      });
    }
    return new Paragraph({
      ...paragraphOptions(format),
      children: [textRun(trimmed, format.body)]
    });
  });
}

export async function writeWord(job, bodyText, options = {}) {
  const suffix = options.suffix || "转写原文";
  const baseName = options.baseName || job.outputBaseTitle || job.title;
  const fileName = `${String(job.order + 1).padStart(2, "0")}_${safeName(baseName)}_${safeName(suffix)}.docx`;
  const outPath = path.join(OUTPUT_DIR, fileName);
  const format = parseDocxFormatRequirement(options.formatRequirement);
  const structuredDocument = parseStructuredDocument(bodyText);
  const contentParagraphs = structuredDocument
    ? structuredToDocxParagraphs(structuredDocument, format)
    : markdownToDocxParagraphs(bodyText, format);
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: options.title || job.title || `视频 ${job.order + 1}`, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: `来源：${job.link}` }),
        new Paragraph({ text: `生成时间：${new Date().toLocaleString("zh-CN")}` }),
        ...contentParagraphs
      ]
    }]
  });
  fs.writeFileSync(outPath, await Packer.toBuffer(doc));
  return { outPath, fileName };
}
