import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { PROVIDERS } from "../../lib/api";
import type { Provider, ResearchStartOptions, SettingsInfo } from "../../lib/api";
import { modelLabel, providerName } from "../../lib/useSettings";
import { useT } from "../../i18n";

/** 本次研究的模型选择：provider 为 default 表示用设置里的默认；core/support 仅在展开"指定型号"后才有。 */
export interface ModelChoice {
  provider: Provider | "default";
  core?: string;
  support?: string;
}

export const DEFAULT_CHOICE: ModelChoice = { provider: "default" };

/** 只把用户改过的部分带给后端，其余由后端按设置里的默认配置档补全。 */
export const modelRequest = (c: ModelChoice): Pick<ResearchStartOptions, "provider" | "core_model" | "support_model"> => ({
  ...(c.provider !== "default" ? { provider: c.provider } : {}),
  ...(c.core ? { core_model: c.core } : {}),
  ...(c.support ? { support_model: c.support } : {}),
});

const select = { padding: "3px 4px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--surface)", color: "var(--text)", fontSize: 12, maxWidth: 190 } as const;

/** 研究页启动区的模型选择：默认 = 设置里的默认提供方；可临时换提供方，展开后可指定核心/辅助型号。 */
export function ModelPicker({ settings, value, onChange }: {
  settings: SettingsInfo | null; value: ModelChoice; onChange: (c: ModelChoice) => void;
}) {
  const { t } = useT();
  const [advanced, setAdvanced] = useState(false);
  if (!settings) return null;

  const effective = value.provider === "default" ? settings.default_profile.provider : value.provider;
  const info = settings.providers[effective];
  const core = value.core ?? (value.provider === "default" ? settings.default_profile.core : info.defaults.core);
  const support = value.support ?? (value.provider === "default" ? settings.default_profile.support : info.defaults.support);
  const modelSelect = (current: string, apply: (id: string) => void) => (
    <select value={current} onChange={(e) => apply(e.target.value)} style={select}>
      {!info.models.some((m) => m.id === current) && <option value={current}>{current}</option>}
      {info.models.map((m) => <option key={m.id} value={m.id}>{modelLabel(t, m, false)}</option>)}
    </select>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--surface2)" }}
         title={t("research.modelTip")}>
      <select value={value.provider} onChange={(e) => onChange({ provider: e.target.value as Provider | "default" })} style={select}>
        <option value="default">{t("research.modelDefault", { name: providerName(settings.default_profile.provider) })}</option>
        {PROVIDERS.map((p) => (
          <option key={p} value={p} disabled={!settings.providers[p].available}>
            {settings.providers[p].available ? providerName(p) : t("research.modelNoKey", { name: providerName(p) })}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => setAdvanced((v) => !v)} title={t("research.modelPick")} aria-pressed={advanced}
        style={{ display: "flex", alignItems: "center", padding: 3, borderRadius: 5, border: "1px solid var(--border)", background: advanced ? "var(--accent-dim)" : "var(--surface)", color: advanced ? "var(--accent)" : "var(--text3)", cursor: "pointer" }}>
        <SlidersHorizontal size={12} />
      </button>
      {advanced && (<>
        {modelSelect(core, (id) => onChange({ ...value, core: id }))}
        {modelSelect(support, (id) => onChange({ ...value, support: id }))}
      </>)}
    </div>
  );
}
