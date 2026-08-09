// 复制到剪贴板的小型组合式函数，带短暂“已复制”反馈。
import { ref } from "vue";

export function useClipboard(resetMs = 1200) {
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(text: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (copied.value = false), resetMs);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  return { copied, copy };
}
