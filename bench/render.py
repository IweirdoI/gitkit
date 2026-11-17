"""Render bilingual publication figures from the sanitized matched measurements."""
import argparse
import json
from pathlib import Path
from statistics import mean

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.ticker import MaxNLocator

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--cjk-font", help="Path to a Chinese font, such as Noto Sans CJK SC")
args = parser.parse_args()
font = font_manager.FontProperties(fname=args.cjk_font) if args.cjk_font else font_manager.FontProperties(
    family=["Noto Sans CJK SC", "Microsoft YaHei", "SimHei"])
source = json.loads((ROOT / "bench/gitkit-0.1.1-full-rerun.json").read_text(encoding="utf-8"))
pairs = []
for task in source["scenarios"]:
    for index in range(1, source["repeats"] + 1):
        rows = {row["arm"]: row for row in source["results"]
                if row["scenario"] == task["id"] and row["repeat"] == index and row["success"]}
        if {"native", "gitkit"} <= rows.keys():
            pairs.append((task["id"], rows))
assert len(pairs) == 12

def token(row):
    return (row["usage"]["input_tokens"] + row["usage"]["output_tokens"]) / 1000

tasks = [task["id"] for task in source["scenarios"]]
metrics = [(lambda row: row["endToEndMs"] / 1000, ".2f"), (token, ".2f")]
translations = {
    "en": ("GitKit 0.1.1 benchmark", "Status|Commit|Pull|First push",
           "End-to-end time (seconds)|Total tokens (thousands)", "Native Git",
           "GPT-6.1-Sol · 12 matched pairs · Task means · Total tokens include cached input · Local bare remotes"),
    "zh": ("GitKit 0.1.1 性能对照", "查看状态|暂存提交|拉取|首次推送",
           "端到端耗时（秒）|总 token（千）", "原生 Git",
           "GPT-6.1-Sol · 12 组配对 · 任务均值 · 总 token 含缓存输入 · 本地裸仓库"),
}
plt.rcParams.update({"text.color": "#172039", "axes.labelcolor": "#172039", "axes.spines.top": False,
                     "axes.spines.right": False, "axes.spines.bottom": False, "axes.spines.left": False})
out = ROOT / "docs/assets"
out.mkdir(parents=True, exist_ok=True)
for lang, (title, labels, axes, baseline, note) in translations.items():
    typography = font if lang == "zh" else font_manager.FontProperties(family="DejaVu Sans")
    fig, panels = plt.subplots(1, 2, figsize=(11, 4.05), facecolor="#ffffff")
    fig.subplots_adjust(left=.101, right=.965, top=.74, bottom=.18, wspace=.4)
    fig.text(.045, .94, title, fontsize=20, weight="bold", fontproperties=typography, va="top")
    for ax, axis, (metric, digits) in zip(panels, axes.split("|"), metrics):
        ax.set_title(axis, loc="left", fontproperties=typography, pad=11, fontsize=11, weight="bold")
        for offset, arm, name, color in ((-.17, "native", baseline, "#a8b3ca"), (.17, "gitkit", "GitKit", "#2558c7")):
            values = [mean(metric(rows[arm]) for key, rows in pairs if key == task) for task in tasks]
            bars = ax.barh([i + offset for i in range(len(tasks))], values, height=.29, color=color, label=name, zorder=3)
            ax.bar_label(bars, labels=[format(v, digits) for v in values], padding=4, fontsize=8)
        ax.set_yticks(range(len(tasks)), labels.split("|"), fontproperties=typography, fontsize=9)
        ax.invert_yaxis()
        ax.set_xlim(0, ax.get_xlim()[1] * 1.18)
        ax.xaxis.set_major_locator(MaxNLocator(5))
        ax.grid(axis="x", color="#e4e9f4", zorder=0)
        ax.tick_params(axis="both", length=0, labelsize=8)
    handles, legend = panels[0].get_legend_handles_labels()
    fig.legend(handles, legend, loc="upper right", bbox_to_anchor=(.976, .97), prop=typography, frameon=False, ncol=2)
    fig.text(.045, .055, note, fontsize=8.8, color="#526077", fontproperties=typography)
    fig.savefig(out / f"benchmark-{lang}.png", dpi=180)
    plt.close(fig)
