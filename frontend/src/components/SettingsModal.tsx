import { useState, useEffect } from "react";
import { X, Eye, EyeOff, Trash2 } from "lucide-react";
import { config as configApi, PROVIDERS } from "../lib/api";
import type { ModelInfo, ProfileChoice, Provider, ProviderInfo, SettingsInfo } from "../lib/api";
import { modelLabel, notifySettingsChanged, providerName } from "../lib/useSettings";
import { useT, type TKey } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

type KeyInputs = Record<Provider, string>;
const EMPTY_INPUTS: KeyInputs = { claude: "", openai: "", zhipu: "" };

const label = { fontSize: 12, color: "var(--text3)", display: "block", marginBottom: 6 } as const;
const field = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)",
  background: "var(--surface2)", color: "var(--text)", fontSize: 13, outline: "none" } as const;

function ModelSelect({ title, tip, value, models, onChange }: {
  title: string; tip: string; value: string; models: ModelInfo[]; onChange: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label style={label} title={tip}>{title}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={field}>
        {!models.some((m) => m.id === value) && <option value={value}>{value}</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(t, m)}</option>)}
      </select>
    </div>
  );
}

function ProviderRadio({ provider, checked, enabled, onSelect }: {
  provider: Provider; checked: boolean; enabled: boolean; onSelect: () => void;
}) {
  const { t } = useT();
  return (
    <button
      type="button" role="radio" aria-checked={checked} disabled={!enabled} onClick={onSelect}
      title={enabled ? undefined : t("common.providerNeedsKey")}
      style={{
        flex: 1, padding: "9px 6px", borderRadius: 8, fontSize: 13, fontWeight: checked ? 700 : 500,
        border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
        background: checked ? "var(--accent-dim)" : "var(--surface2)",
        color: checked ? "var(--accent)" : "var(--text)",
        opacity: enabled ? 1 : 0.45, cursor: enabled ? "pointer" : "not-allowed",
      }}
    >
      {providerName(provider)}
    </button>
  );
}

function ProfileSection({ settings, draft, inputs, onChange }: {
  settings: SettingsInfo; draft: ProfileChoice; inputs: KeyInputs; onChange: (p: ProfileChoice) => void;
}) {
  const { t } = useT();
  const models = settings.providers[draft.provider]?.models ?? [];
  const pick = (provider: Provider) => {
    const { core, support } = settings.providers[provider].defaults;
    onChange({ provider, core, support });
  };
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={label}>{t("common.defaultProvider")}</div>
      <div role="radiogroup" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {PROVIDERS.map((p) => (
          <ProviderRadio key={p} provider={p} checked={draft.provider === p}
            enabled={settings.providers[p].available || inputs[p].trim() !== ""} onSelect={() => pick(p)} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <ModelSelect title={t("common.coreModel")} tip={t("common.coreModelTip")} value={draft.core} models={models}
          onChange={(core) => onChange({ ...draft, core })} />
        <ModelSelect title={t("common.supportModel")} tip={t("common.supportModelTip")} value={draft.support} models={models}
          onChange={(support) => onChange({ ...draft, support })} />
      </div>
      <div style={{ fontSize: 11, color: "var(--text4)", marginTop: 6 }}>{t("common.priceHint")}</div>
    </div>
  );
}

function KeyField({ provider, info, value, onChange, onClear }: {
  provider: Provider; info: ProviderInfo; value: string; onChange: (v: string) => void; onClear: () => void;
}) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={label}>{t(`common.keyLabel.${provider}` as TKey)}</label>
      {provider === "claude" && <div style={{ fontSize: 11, color: "var(--text4)", marginBottom: 6 }}>{t("common.claudeNote")}</div>}
      <div style={{ fontSize: 12, marginBottom: 6, color: info.has_key ? "var(--success)" : "var(--text4)" }}>
        {info.has_key ? t("common.keyConfigured", { last4: info.key_preview.slice(-4) }) : t("common.keyMissing")}
        {info.key_source === "env" && ` ${t("common.keyFromEnv")}`}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ ...field, flex: 1, display: "flex", alignItems: "center", padding: "0 10px" }}>
          <input
            type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)}
            placeholder={t("common.keyPlaceholder")} autoComplete="off"
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 13, color: "var(--text)", padding: "8px 0" }}
          />
          <button type="button" onClick={() => setShow(!show)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 2 }}>
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {info.key_source === "keyring" && (
          <button type="button" onClick={onClear} title={t("common.keyClearTip")} aria-label={t("common.keyClear")}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "none", cursor: "pointer", color: "var(--text3)" }}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [draft, setDraft] = useState<ProfileChoice | null>(null);
  const [inputs, setInputs] = useState<KeyInputs>(EMPTY_INPUTS);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { t } = useT();

  const apply = (s: SettingsInfo) => { setSettings(s); setDraft(s.default_profile); setInputs(EMPTY_INPUTS); };

  useEffect(() => {
    if (!open) return;
    setError("");
    configApi.get().then(apply).catch(() => setError(t("common.settingsLoadFailed")));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const api_keys = Object.fromEntries(PROVIDERS.filter((p) => inputs[p].trim()).map((p) => [p, inputs[p].trim()]));
      apply(await configApi.update({ default_profile: draft, api_keys }));
      notifySettingsChanged();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(t("common.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(provider: Provider) {
    try {
      setSettings(await configApi.clearKey(provider));
      setInputs((i) => ({ ...i, [provider]: "" }));
      notifySettingsChanged();
    } catch (e) {
      setError(t("common.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.45)",
        zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)", borderRadius: 16, padding: 28,
          width: 560, maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto",
          boxShadow: "0 12px 40px rgba(0,0,0,.25)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{t("common.settings")}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        {settings && draft && (
          <>
            <ProfileSection settings={settings} draft={draft} inputs={inputs} onChange={setDraft} />
            <div style={{ ...label, fontWeight: 700 }}>{t("common.apiKeys")}</div>
            {PROVIDERS.map((p) => (
              <KeyField key={p} provider={p} info={settings.providers[p]} value={inputs[p]}
                onChange={(v) => setInputs((i) => ({ ...i, [p]: v }))} onClear={() => handleClear(p)} />
            ))}
          </>
        )}
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--danger)", marginBottom: 10, wordBreak: "break-word" }}>{error}</div>}

        <button
          onClick={handleSave}
          disabled={saving || !draft}
          style={{
            width: "100%", padding: "10px", borderRadius: 10, border: "none", marginTop: 6,
            background: saved ? "#10B981" : "linear-gradient(135deg, var(--accent), var(--accent-hover))",
            color: "#fff", fontSize: 14, fontWeight: 600, cursor: saving ? "default" : "pointer",
            transition: "background .3s", opacity: draft ? 1 : 0.5,
          }}
        >
          {saved ? t("common.saved") : saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
