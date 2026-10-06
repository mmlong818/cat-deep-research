"""回归用的固定问题与基线报告。基线换版本时在这里登记，旧基线保留以便对比历史结果。"""
import os

QUESTIONS = {
    "Q1": "2026年主流开源大模型（DeepSeek、Qwen、GLM）在编程能力上的最新对比与差距",
    "Q2": "2026年全球固态电池量产进展与主要厂商时间表",
}

_BASELINE_DIR = os.path.join(os.path.dirname(__file__), "baselines")

# P2：upgrade/sdk-opus55 分支（ce36cd6）跑出的 Q2 最终稿，E8 起的盲评基线
BASELINES = {
    "Q2": os.path.join(_BASELINE_DIR, "q2_p2.md"),
}
