<script setup lang="ts">
// JWT 解码器（仅解析，不验签）：
// - 显著警告：不验证签名，不能证明令牌可信
// - 超大 token 限制（防 DoS）
// - 清除敏感内容按钮
// - 不使用 v-html，纯文本渲染
// - 页面离开时清除（sensitiveInput）
import { computed, ref, onUnmounted } from "vue";
import { t } from "@/i18n";
import ToolShell from "@/components/ToolShell.vue";
import { toolErrorMessage } from "@/lib/tools/errors";
import AppIcon from "@/components/AppIcon.vue";
import { jwtDecode, type JwtParts } from "@/lib/tools/transforms";

const MAX_TOKEN_SIZE = 100_000; // 100KB 上限

const token = ref("");

const sizeError = computed<string | null>(() => {
  if (token.value.length > MAX_TOKEN_SIZE) {
    return t("util.jwt.tooLarge", { max: MAX_TOKEN_SIZE });
  }
  return null;
});

const result = computed<{ value: JwtParts | null; error: string | null }>(() => {
  if (sizeError.value) return { value: null, error: sizeError.value };
  if (!token.value.trim()) return { value: null, error: null };
  try {
    return { value: jwtDecode(token.value), error: null };
  } catch (e) {
    return { value: null, error: toolErrorMessage(e) };
  }
});
const decoded = computed(() => result.value.value);
const error = computed(() => result.value.error);

const headerText = computed(() =>
  decoded.value ? JSON.stringify(decoded.value.header, null, 2) : "",
);
const payloadText = computed(() =>
  decoded.value ? JSON.stringify(decoded.value.payload, null, 2) : "",
);

// 过期时间解释（仅作为字段解释，不是验证结果）
const expiryInfo = computed<string | null>(() => {
  if (!decoded.value) return null;
  const payload = decoded.value.payload as Record<string, unknown>;
  const exp = payload?.exp;
  if (typeof exp !== "number") return null;
  const d = new Date(exp * 1000);
  const now = new Date();
  const expired = d.getTime() < now.getTime();
  return expired
    ? t("util.jwt.expired", { time: d.toLocaleString() })
    : t("util.jwt.expiresAt", { time: d.toLocaleString() });
});

function clearSensitive(): void {
  token.value = "";
}

// 页面离开时清除敏感内容
onUnmounted(() => {
  token.value = "";
});
</script>

<template>
  <ToolShell :title="t('util.jwt.name')" :description="t('util.jwt.desc')" :error="error">
    <!-- 显著安全警告 -->
    <div class="jwt-warn">
      <AppIcon name="alert" :size="16" />
      <span>{{ t("util.jwt.warn") }}</span>
    </div>
    <div class="tool-io tool-io--single">
      <textarea
        v-model="token"
        class="useful-input tool-pane useful-mono"
        style="min-height: 100px"
        placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
        spellcheck="false"
        :maxlength="MAX_TOKEN_SIZE"
      />
    </div>
    <div class="tool-row">
      <button
        v-if="token"
        class="useful-btn useful-btn--ghost"
        @click="clearSensitive"
      >
        <AppIcon name="trash" :size="16" /> {{ t("util.jwt.clear") }}
      </button>
      <span v-if="token" class="jwt-size">{{ token.length }} chars</span>
    </div>
    <div v-if="decoded" class="tool-io">
      <p v-if="expiryInfo" class="jwt-expiry">
        <AppIcon name="clock" :size="14" /> {{ expiryInfo }}
      </p>
      <div class="tool-field">
        <span>Header</span>
        <pre class="tool-pane tool-pane--out useful-mono">{{ headerText }}</pre>
      </div>
      <div class="tool-field">
        <span>Payload</span>
        <pre class="tool-pane tool-pane--out useful-mono">{{ payloadText }}</pre>
      </div>
    </div>
  </ToolShell>
</template>

<style scoped>
.jwt-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--useful-text-sm);
  color: var(--useful-danger);
  background: var(--useful-bg-layer);
  border: 1px solid var(--useful-danger);
  border-radius: var(--useful-radius-md);
  padding: 8px 12px;
  margin: 0;
}
.jwt-expiry {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--useful-text-xs);
  color: var(--useful-text-secondary);
  margin: 0 0 var(--useful-space-2);
}
.jwt-size {
  font-size: var(--useful-text-xs);
  color: var(--useful-text-tertiary);
  font-family: var(--useful-font-mono);
}
</style>
