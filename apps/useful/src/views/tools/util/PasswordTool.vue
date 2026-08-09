<script setup lang="ts">
// 密码生成器（敏感工具）：
// - 使用 crypto.getRandomValues CSPRNG（已实现）
// - 支持排除易混淆字符
// - 显示近似熵（不宣称绝对安全）
// - 不保存、不进入最近输入
// - 页面离开时清除结果
import { ref, computed, onUnmounted } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { toolErrorMessage } from "@/lib/tools/errors";
import AppIcon from "@/components/AppIcon.vue";
import { generatePassword, estimateEntropy, type PasswordOptions } from "@/lib/tools/transforms";
import { useClipboard } from "@/lib/tools/useClipboard";

const opts = ref<PasswordOptions>({
  length: 16,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
});
const password = ref("");
const error = ref<string | null>(null);
const { copied, copy } = useClipboard();

// 近似熵（bit）
const entropy = computed(() => estimateEntropy(opts.value));

// 熵强度提示（仅参考，不宣称安全）
const entropyLabel = computed(() => {
  const e = entropy.value;
  if (e >= 128) return { text: t("util.password.entropy.veryStrong"), color: "var(--useful-accent)" };
  if (e >= 80) return { text: t("util.password.entropy.strong"), color: "var(--useful-accent)" };
  if (e >= 60) return { text: t("util.password.entropy.moderate"), color: "var(--useful-warning)" };
  return { text: t("util.password.entropy.weak"), color: "var(--useful-danger)" };
});

function regenerate(): void {
  error.value = null;
  try {
    password.value = generatePassword(opts.value);
  } catch (e) {
    error.value = toolErrorMessage(e);
    password.value = "";
  }
}
regenerate();

// 页面离开时清除密码
onUnmounted(() => {
  password.value = "";
});
</script>

<template>
  <ToolShell
    :title="t('util.password.name')"
    :description="t('util.password.desc')"
    :error="error"
  >
    <!-- 隐私提示 -->
    <p class="pw-privacy">
      <AppIcon name="shield" :size="14" /> {{ t("util.localProcessing") }}
    </p>
    <div class="tool-row">
      <label class="tool-opt">
        {{ t("util.password.length") }}
        <input
          v-model.number="opts.length"
          class="useful-input"
          type="number"
          min="4"
          max="256"
          style="width: 90px"
          @input="regenerate"
        />
      </label>
      <label class="tool-opt"
        ><input v-model="opts.lower" type="checkbox" @change="regenerate" /> a-z</label
      >
      <label class="tool-opt"
        ><input v-model="opts.upper" type="checkbox" @change="regenerate" /> A-Z</label
      >
      <label class="tool-opt"
        ><input v-model="opts.digits" type="checkbox" @change="regenerate" /> 0-9</label
      >
      <label class="tool-opt"
        ><input v-model="opts.symbols" type="checkbox" @change="regenerate" />
        {{ t("util.password.symbols") }}</label
      >
      <label class="tool-opt"
        ><input v-model="opts.excludeAmbiguous" type="checkbox" @change="regenerate" />
        {{ t("util.password.excludeAmbiguous") }}</label
      >
    </div>
    <div class="tool-row">
      <button class="useful-btn useful-btn--primary" @click="regenerate">
        <AppIcon name="refresh" :size="16" />{{ t("util.password.generate") }}
      </button>
      <button class="useful-btn" :disabled="!password" @click="copy(password)">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        {{ copied ? t("util.copied") : t("util.copy") }}
      </button>
      <span class="pw-entropy" :style="{ color: entropyLabel.color }">
        ~{{ entropy }} bit · {{ entropyLabel.text }}
      </span>
    </div>
    <div class="tool-io tool-io--single">
      <pre class="tool-pane tool-pane--out useful-mono pw">{{ password }}</pre>
    </div>
    <p class="pw-disclaimer">{{ t("util.password.entropyNote") }}</p>
  </ToolShell>
</template>

<style scoped>
.pw-privacy {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0;
}
.pw {
  font-size: var(--useful-text-lg);
  min-height: 64px;
}
.pw-entropy {
  font-size: var(--useful-text-sm);
  font-family: var(--useful-font-mono);
}
.pw-disclaimer {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  margin: 0;
}
</style>
