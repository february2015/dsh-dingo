/**
 * 回复文本 → 是否需要用户回答（dsh-dingo 判定"有回复" vs "需回答"）。
 *
 * 复用自 dsh-localvoice（broadcast.ts），独立成模块供 host 判定当前对话
 * 提醒级别：回复含疑问/请求确认 → "需回答"（叮叮 2 声），否则 "有回复"（叮 1 声）。
 */

/** 回复文本是否"需回答"（含疑问/请求确认特征）。 */
export function isQuestionText(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (/[？?]$/.test(t)) return true; // 以问号结尾
  return /(吗|呢|怎么|怎样|如何|什么|哪|是否|能不能|可不可以|可以吗|行不行|好不好|要不要|请确认|需要你确认|确认一下|请回答|等你确认|等你回复|请选择|给个建议|你看|你觉得|你认为)/.test(t);
}
