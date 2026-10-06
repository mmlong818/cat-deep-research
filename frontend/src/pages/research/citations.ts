// 与后端 research/ledger.py 的 CITE 一致：[C12] 或 [C1, C2]
const CITE = /\[(C\d+(?:\s*[,，、]\s*C\d+)*)\]/g;
// 与后端 research/ledger.py 的 REFS_HEADINGS 一致：中英文报告的附录标题都认（旧报告是中文）
const REFS_HEADINGS = ["声明来源", "Claim sources"];
const APPENDIX = new RegExp(`^## (?:${REFS_HEADINGS.join("|")})\\s*$`, "m");

/** 正文引用变成跳到附录的链接，附录条目加锚点。 */
export function linkCitations(md: string): string {
  const m = APPENDIX.exec(md);
  const body = m ? md.slice(0, m.index) : md;
  const appendix = m ? md.slice(m.index) : "";
  const linked = body.replace(CITE, (_, ids: string) =>
    "[" + ids.split(/\s*[,，、]\s*/).map((id) => `[${id}](#cite-${id})`).join(", ") + "]");
  return linked + appendix.replace(/^- \*\*\[(C\d+)\]\*\*/gm, '- <a id="cite-$1"></a>**[$1]**');
}
