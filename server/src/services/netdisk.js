export const NETDISK_PROVIDERS = {
  baidu: {
    id: "baidu",
    name: "百度网盘",
    supported: true,
    patterns: [/pan\.baidu\.com/i, /yun\.baidu\.com/i]
  },
  quark: {
    id: "quark",
    name: "夸克网盘",
    supported: true,
    patterns: [/pan\.quark\.cn/i, /drive\.uc\.cn/i]
  }
};

export function detectNetdiskProvider(link) {
  const text = String(link || "");
  for (const provider of Object.values(NETDISK_PROVIDERS)) {
    if (provider.patterns.some((pattern) => pattern.test(text))) return provider;
  }
  if (/https?:\/\/[^\s]+/i.test(text) && /(pan|drive|cloud|yun|网盘)/i.test(text)) {
    return { id: "unknown", name: "未知网盘", supported: false };
  }
  return null;
}

export function unsupportedNetdiskMessage(provider) {
  return `${provider?.name || "该网盘"}暂不支持。当前只支持百度网盘和夸克网盘；其他网盘请改用公网音视频直链。`;
}
