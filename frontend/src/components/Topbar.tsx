import { useState } from "react";
import { useLocation } from "wouter";
import { FlaskConical, Target, Settings } from "lucide-react";
import { guardNavigate } from "../lib/workGuard";
import SettingsModal from "./SettingsModal";
import { useT, type TKey } from "../i18n";
import LangSwitch from "../i18n/LangSwitch";

const TOOLS: { path: string; label: TKey; icon: typeof Target; tool: string; color: string }[] = [
  { path: "/research", label: "common.tool.research", icon: FlaskConical, tool: "research", color: "#B8721A" },
];

export default function Topbar({ online }: { online?: boolean }) {
  const [location, navigate] = useLocation();
  const [showSettings, setShowSettings] = useState(false);
  const { t } = useT();

  return (
    <>
    <header
      style={{
        height: "var(--topbar-h)",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        padding: "0 20px",
        gap: "24px",
        zIndex: 100,
        boxShadow: "0 1px 3px rgba(184,114,26,.08)",
      }}
    >
      {/* Logo */}
      <button
        onClick={() => guardNavigate(navigate, "/")}
        style={{ display: "flex", alignItems: "center", gap: "10px", background: "none", border: "none", cursor: "pointer" }}
      >
        <img src="/logo.png" alt="DJ" style={{ width: 60, height: 60, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 15, fontWeight: 700, background: "linear-gradient(135deg, #B8721A, #7A3F00)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            {t("common.toolbox")}
          </div>
        </div>
      </button>

      {/* Tool tabs */}
      <nav style={{ display: "flex", gap: 4, flex: 1 }}>
        {TOOLS.map((tool) => {
          const active = location.startsWith(tool.path);
          const Icon = tool.icon;
          return (
            <button
              key={tool.path}
              onClick={() => guardNavigate(navigate, tool.path)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 14px", borderRadius: 8, border: "none",
                fontSize: 15, fontWeight: active ? 600 : 500,
                cursor: "pointer",
                transition: "all .15s",
                background: active ? `${tool.color}18` : "transparent",
                color: active ? tool.color : "var(--text2)",
                borderBottom: active ? `2px solid ${tool.color}` : "2px solid transparent",
              }}
            >
              <Icon size={14} />
              {t(tool.label)}
            </button>
          );
        })}
      </nav>

      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <LangSwitch />
        <button
          onClick={() => setShowSettings(true)}
          title={t("common.settings")}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 4, display: "flex", alignItems: "center" }}
        >
          <Settings size={16} />
        </button>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: online ? "var(--success)" : "var(--border2)",
          boxShadow: online ? "0 0 0 3px rgba(16,185,129,.2)" : "none",
          transition: "all .3s",
        }} />
        <span style={{ fontSize: 13, color: "var(--text2)" }}>
          {online ? t("common.online") : t("common.offline")}
        </span>
      </div>
    </header>
    <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}
