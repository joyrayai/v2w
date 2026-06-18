import { defaultPrompt } from "../config.js";

export async function submitAsr(audioUrl, settings) {
  const apiKey = settings.dashscopeApiKey;
  if (!apiKey) throw new Error("缺少阿里云百炼 DashScope API Key。");
  const res = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable"
    },
    body: JSON.stringify({
      model: settings.asrModel || "paraformer-v2",
      input: { file_urls: [audioUrl] },
      parameters: {
        language_hints: settings.languageHints || ["zh", "en"],
        disfluency_removal_enabled: true,
        timestamp_alignment_enabled: false,
        diarization_enabled: Boolean(settings.diarizationEnabled)
      }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`提交转写失败：${JSON.stringify(json)}`);
  return json.output.task_id;
}

export async function pollAsr(taskId, settings) {
  const apiKey = settings.dashscopeApiKey;
  for (let i = 0; i < 240; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const res = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const json = await res.json();
    const status = json.output?.task_status;
    if (status === "SUCCEEDED") {
      const result = json.output.results?.[0];
      if (result?.subtask_status !== "SUCCEEDED") throw new Error(result?.message || "转写子任务失败");
      return fetch(result.transcription_url).then((r) => r.json());
    }
    if (status === "FAILED" || status === "CANCELED") throw new Error(`转写任务失败：${JSON.stringify(json)}`);
  }
  throw new Error("转写等待超时。");
}

export function transcriptToText(transcript) {
  const transcriptItems = transcript.transcripts || [];
  return transcriptItems.map((item) => {
    if (Array.isArray(item.sentences) && item.sentences.length) {
      return item.sentences.map((sentence) => {
        return sentence.speaker_id != null ? `说话人${sentence.speaker_id + 1}：${sentence.text}` : sentence.text;
      }).join("\n");
    }
    return item.text || "";
  }).filter(Boolean).join("\n\n");
}

export async function polishText(text, prompt, settings) {
  const result = await polishTextDetailed(text, prompt, settings);
  return result.content;
}

const extraDocSystemPrompt = [
  "你是视频转写后的文档生成助手。",
  "必须严格执行用户给出的额外文件处理要求。用户要求扩写、改写、生成问答、大纲、演讲稿、逐字稿或其他格式时，按该要求输出。",
  "用户要求字数、篇幅或详细程度时，尽量满足，不要主动压缩成摘要。",
  "可以基于转写文本做结构化、润色和必要补足；如果用户要求专业补充，在不偏离转写文本主题的前提下补充。",
  "不要因为文件名、默认名称或历史上下文把任务理解成“提炼”。",
  "除非用户要求，否则不要输出与要求无关的解释。"
].join("\n");

function usageMeta(json, settings) {
  return {
    usage: json.usage || null,
    model: json.model || String(settings.qwenModel || "").trim(),
    provider: settings.llmProvider || "llm"
  };
}

export async function chatCompletion(messages, settings, temperature = 0.2, extraBody = {}) {
  const apiKey = settings.llmApiKey || settings.dashscopeApiKey;
  if (!apiKey) throw new Error("缺少模型 API Key。");
  const baseUrl = (settings.llmBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: String(settings.qwenModel || "").trim(),
      messages,
      temperature,
      ...extraBody
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`模型处理失败：${JSON.stringify(json)}`);
  return json;
}

export async function testLlmConnection(settings) {
  const apiKey = settings.llmApiKey || settings.dashscopeApiKey;
  if (!apiKey) throw new Error("缺少模型 API Key。");
  const model = String(settings.qwenModel || "").trim();
  if (!model) throw new Error("缺少 AI 处理模型名称。");
  const baseUrl = (settings.llmBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0
    })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || `连接失败：HTTP ${res.status}`);
  }
  return { ok: true, model: json?.model || model };
}

export async function polishTextDetailed(text, prompt, settings) {
  const userPrompt = String(prompt || defaultPrompt).trim();
  const json = await chatCompletion([
    { role: "system", content: extraDocSystemPrompt },
    {
      role: "user",
      content: [
        "用户的额外文件处理要求如下。请优先且严格执行这段要求：",
        userPrompt,
        "",
        "转写文本如下：",
        text
      ].join("\n")
    }
  ], settings);
  return {
    content: json.choices?.[0]?.message?.content || text,
    ...usageMeta(json, settings)
  };
}

export async function polishTextWithTitle(text, prompt, settings) {
  const result = await polishTextWithTitleDetailed(text, prompt, settings);
  return { title: result.title, content: result.content };
}

export async function polishTextWithTitleDetailed(text, prompt, settings) {
  const response = await polishTextDetailed(text, prompt, settings);
  const titleResponse = await generateDocumentTitleDetailed(text, [{ label: "正文", content: response.content }], settings);
  return {
    title: titleResponse.title,
    content: response.content,
    usage: mergeUsage(response.usage, titleResponse.usage),
    model: response.model,
    provider: response.provider
  };
}

export async function generateDocumentTitleDetailed(sourceText, outputs, settings) {
  const outputSummary = outputs.map((item, index) => {
    const label = item.label || `文档 ${index + 1}`;
    return `【${label}】\n${String(item.content || "").slice(0, 2000)}`;
  }).join("\n\n");
  const json = await chatCompletion([
    {
      role: "system",
      content: "你只负责给已经生成好的文档起一个统一文件名，不要改写正文。"
    },
    {
      role: "user",
      content: [
        "请根据下面的转写主题和已生成文档，生成一个适合做 Word 文件名的短标题。",
        "要求：只返回 JSON，不要 Markdown，不要解释。格式：{\"title\":\"最多 30 个中文字符的文件名\"}",
        "标题必须来自真实主题，不要使用“提炼版”“总结版”“额外文档”等泛化名称。",
        "",
        "转写文本片段：",
        String(sourceText || "").slice(0, 3000),
        "",
        "已生成文档片段：",
        outputSummary
      ].join("\n")
    }
  ], settings, 0.1);
  return {
    title: parseTitleOnly(json.choices?.[0]?.message?.content || ""),
    ...usageMeta(json, settings)
  };
}

function mergeUsage(a, b) {
  if (!a && !b) return null;
  return {
    prompt_tokens: (a?.prompt_tokens || 0) + (b?.prompt_tokens || 0),
    completion_tokens: (a?.completion_tokens || 0) + (b?.completion_tokens || 0),
    total_tokens: (a?.total_tokens || 0) + (b?.total_tokens || 0)
  };
}

export function parseTitleOnly(response) {
  const text = String(response || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [fenced, text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.title) return String(parsed.title).trim();
    } catch {
      // Try the next parse strategy.
    }
  }
  const titleMatch = text.match(/(?:^|\n)标题[:：]\s*(.+)/);
  return (titleMatch?.[1] || text).replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 30);
}

export function parseTitleContent(response) {
  const text = String(response || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [fenced, text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.title && parsed?.content) {
        return { title: String(parsed.title).trim(), content: String(parsed.content).trim() };
      }
    } catch {
      // Try the next parse strategy.
    }
  }

  const titleMatch = text.match(/(?:^|\n)标题[:：]\s*(.+)/);
  const contentMatch = text.match(/(?:^|\n)(?:正文|内容)[:：]\s*([\s\S]+)/);
  if (titleMatch && contentMatch) {
    return { title: titleMatch[1].trim(), content: contentMatch[1].trim() };
  }
  return { title: "", content: text };
}
