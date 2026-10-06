"""
ConclusionValidatorAgent - 结论验证智能体
对研究报告的结论进行全面性和准确性验证
"""
import os

import config as _config
from agents.llm_agent import LLMAgent, read_text
from research.confidence import combine, component_scores

SCORE_KEYS = ["evidence_sufficiency", "logical_rigor", "coverage_completeness",
              "practical_value", "limitations_acknowledged"]


CONCLUSION_VALIDATOR_SYSTEM_PROMPT = """你是一位严格的研究结论验证专家，专注于确保研究结论的逻辑严密性、全面性和准确性。

## 你的职责
1. 验证结论是否有充分的证据支撑
2. 检查结论覆盖的广度是否足够
3. 识别结论中可能存在的逻辑漏洞
4. 评估结论对原始问题的回答是否完整
5. 提出针对性的改进建议

## 验证维度（每项0-10分）
- **证据充分性**：结论是否有足够的事实和数据支撑
- **逻辑严密性**：推理过程是否严密，无明显跳跃
- **覆盖全面性**：是否覆盖了问题的各个重要方面
- **实用价值**：结论是否具有实际指导意义
- **局限性说明**：是否合理说明了研究局限

## 判定标准
- overall_verdict："pass" 表示结论质量达标，"needs_improvement" 表示需要改进，"fail" 表示需要重写
- 平均分 >= 7.5 可考虑 "pass"，6-7.5 为 "needs_improvement"，< 6 为 "fail"
- improvement_instructions 必须具体、可操作（3-5 条），帮助写作智能体快速改进"""


def _str_list():
    return {"type": "array", "items": {"type": "string"}}


VALIDATION_SCHEMA = {
    "type": "object",
    "properties": {
        "validation_scores": {
            "type": "object",
            "properties": {k: {"type": "number"} for k in SCORE_KEYS},
            "required": SCORE_KEYS,
            "additionalProperties": False,
        },
        "strengths": _str_list(),
        "gaps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "gap": {"type": "string"},
                    "importance": {"type": "string", "enum": ["high", "medium", "low"]},
                    "suggestion": {"type": "string"},
                },
                "required": ["gap", "importance", "suggestion"],
                "additionalProperties": False,
            },
        },
        "logic_issues": _str_list(),
        "missing_perspectives": _str_list(),
        "overall_verdict": {"type": "string", "enum": ["pass", "needs_improvement", "fail"]},
        "improvement_instructions": {"type": "string"},
    },
    "required": ["validation_scores", "strengths", "gaps", "logic_issues",
                 "missing_perspectives", "overall_verdict", "improvement_instructions"],
    "additionalProperties": False,
}


class ConclusionValidatorAgent(LLMAgent):
    def __init__(self, model: str | None = None):
        super().__init__(name="结论验证员", system_prompt=CONCLUSION_VALIDATOR_SYSTEM_PROMPT,
                         model=model or _config.CONCLUSION_VALIDATOR_MODEL, schema=VALIDATION_SCHEMA)

    def validate_conclusions(self, workspace: str, draft_file: str | None = None,
                             source_verification: dict | None = None,
                             fact_check: dict | None = None,
                             registry: dict | None = None,
                             cycle: int = 1) -> tuple:
        """验证研究报告的结论质量，返回 (验证 dict, 文件路径)；失败抛 LLMError。"""
        output_file = os.path.join(workspace, "08_verification", "conclusion_validation.json")
        draft_file = draft_file or _find_latest_draft(os.path.join(workspace, "06_drafts"))

        prompt = f"""请对研究报告的结论进行全面验证（第 {cycle} 轮）。

## 研究计划（原始问题与研究维度）
{read_text(os.path.join(workspace, "03_plan.json")) or "（无）"}

## 来源可信度评估摘要
{_source_summary(source_verification)}

## 事实核查摘要
{_fact_summary(fact_check)}

## 待验证的草稿
{read_text(draft_file)}

## 要求
重点关注结论章节，确认结论是否完整回答了研究计划中的原始问题，
并对照来源质量和事实核查结果评估结论可信度。"""

        def finalize(data: dict) -> dict:
            return with_confidence(data, source_verification, fact_check)

        return self.ask(prompt, output_file, finalize), output_file


def with_confidence(data: dict, source_verification: dict | None, fact_check: dict | None) -> dict:
    """补上确定性字段：平均分与综合置信度（缺失部分剔除后归一化，见 research.confidence）。"""
    vals = [min(max(float(data["validation_scores"][k]), 0.0), 10.0) for k in SCORE_KEYS]
    data["average_score"] = round(sum(vals) / len(vals), 2)
    combined = combine(component_scores(source_verification, fact_check, data))
    data["conclusion_confidence"] = combined["overall"]
    data["confidence_breakdown"] = combined
    return data


def _find_latest_draft(drafts_dir: str):
    if not os.path.isdir(drafts_dir):
        return None
    nums = [int(f[6:-3]) for f in os.listdir(drafts_dir)
            if f.startswith("draft_") and f.endswith(".md") and f[6:-3].isdigit()]
    return os.path.join(drafts_dir, f"draft_{max(nums)}.md") if nums else None


def _source_summary(sv: dict | None) -> str:
    if not sv or not sv.get("total_sources"):
        return "（来源验证未完成或没有来源）"
    s = sv["summary"]
    return f"- 来源平均得分：{s['average_score']:.1f}/100\n- 高可信来源数：{s['high_confidence_count']}"


def _fact_summary(fc: dict | None) -> str:
    if not fc:
        return "（事实核查未完成）"
    return (f"- 整体置信度：{fc['overall_confidence']:.0%}\n"
            f"- 已核查声明数：{fc.get('total_claims_checked', 0)}\n"
            f"- 争议声明：{fc.get('disputed_claims', [])[:3]}")
