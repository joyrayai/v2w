import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { OUTPUT_DIR } from "../config.js";
import { safeName } from "../utils.js";

function markdownToDocxParagraphs(markdown) {
  return String(markdown || "").split(/\n+/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return new Paragraph("");
    if (trimmed.startsWith("### ")) return new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3 });
    if (trimmed.startsWith("## ")) return new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 });
    if (trimmed.startsWith("# ")) return new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 });
    if (/^[-*]\s+/.test(trimmed)) return new Paragraph({ text: trimmed.replace(/^[-*]\s+/, ""), bullet: { level: 0 } });
    return new Paragraph({ children: [new TextRun(trimmed)] });
  });
}

export async function writeWord(job, bodyText, options = {}) {
  const suffix = options.suffix || "转写原文";
  const baseName = options.baseName || job.outputBaseTitle || job.title;
  const fileName = `${String(job.order + 1).padStart(2, "0")}_${safeName(baseName)}_${safeName(suffix)}.docx`;
  const outPath = path.join(OUTPUT_DIR, fileName);
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: options.title || job.title || `视频 ${job.order + 1}`, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: `来源：${job.link}` }),
        new Paragraph({ text: `生成时间：${new Date().toLocaleString("zh-CN")}` }),
        ...markdownToDocxParagraphs(bodyText)
      ]
    }]
  });
  fs.writeFileSync(outPath, await Packer.toBuffer(doc));
  return { outPath, fileName };
}
