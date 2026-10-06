import { useT } from "./index";

/** 中/EN 切换按钮；首页、产品页等没有 Topbar 的页面也直接挂这个组件。 */
export default function LangSwitch() {
  const { lang, setLang, t } = useT();
  return (
    <button
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
      title={t("common.language")}
      style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text2)", fontSize: 12, cursor: "pointer" }}
    >
      {lang === "zh" ? "EN" : "中"}
    </button>
  );
}
