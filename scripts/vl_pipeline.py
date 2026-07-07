#!/usr/bin/env python3
# 단계 분리 파이프라인 — 순서 A vs B 비교, 5개 모델 전부 (mlx, Apple Silicon 전용)
#
# 공통 1) OCR: 사진에서 번체 원문 추출
# 경우 A (요약 먼저): 번체 원문 → ②번체 요약 → ③한글 번역
# 경우 B (번역 먼저): 번체 원문 → ②한글 번역 → ③한글 요약
#
# 모델마다 별도 프로세스로 돌린다(크래시 나도 그 모델만 스킵). 결과 누적.
#
# 실행:
#   source ../.venv-vl/bin/activate
#   python scripts/vl_pipeline.py            # 5개 모델 × 게시물 5개
#   python scripts/vl_pipeline.py 15         # 게시물 15개
#   python scripts/vl_pipeline.py 5 --only 1 # 1번 모델만

import sys
import os
import json
import time
import glob
import subprocess

sys.path.insert(0, "scripts")
import vl_compare as V  # pick_images / downscaled / MODEL_INFO 재사용

MODELS = list(V.MODEL_INFO.keys())  # vl_compare 와 동일한 5개
OUT = "vl_results/pipeline"
MAX_TOK = 256

# ── 프롬프트 (단계별) ──────────────────────────────────────────
P_OCR = "이미지 속 글자를 번체중문(繁體) 그대로 추출해라. 다른 말 없이 글자만 출력."
# 경우 A (요약 먼저)
PA_SUM = ("다음 번체중문을 한 줄 제목으로 요약해라. 반드시 번체(繁體) 유지, 간체(简体) 금지. "
          "제목만 출력(15자 내외):\n{txt}")
PA_TRANS = ("다음 번체중문 제목을 자연스러운 한국어로 번역해라. 한자 섞지 말 것. "
            "번역문만 출력:\n{txt}")
# 경우 B (번역 먼저)
PB_TRANS = ("다음 번체중문을 자연스러운 한국어로 번역해라. 한자 섞지 말 것. 번역문만 출력:\n{txt}")
PB_SUM = ("다음 한국어를 한 줄 제목으로 요약해라. 순수 한국어로 제목만 출력(15자 내외):\n{txt}")
# ───────────────────────────────────────────────────────────


def clean(s):
    return (s or "").strip().strip('"').replace("\n", " ")


def partial_path(model):
    return os.path.join(OUT, "_p_" + model.replace("/", "__") + ".json")


def resolve(name):
    if name.isdigit():
        i = int(name) - 1
        if 0 <= i < len(MODELS):
            return MODELS[i]
        sys.exit(f"모델 번호 범위 밖: 1~{len(MODELS)}")
    return name


# ── 자식: 모델 1개로 A/B 파이프라인 ──────────────────────────────
def run_one(model, images):
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template

    print(f"\n▶ 로딩: {model}")
    m, processor = load(model, trust_remote_code=True)
    config = getattr(m, "config", None)

    def step(prompt_text, image=None):
        ni = 1 if image else 0
        prompt = apply_chat_template(processor, config, prompt_text, num_images=ni)
        if image:
            out = generate(m, processor, prompt, image=[image], max_tokens=MAX_TOK, verbose=False)
        else:
            out = generate(m, processor, prompt, max_tokens=MAX_TOK, verbose=False)
        return clean(out.text if hasattr(out, "text") else str(out))

    cache = V.RESIZE_CACHE
    pfile = partial_path(model)
    rows = []
    for i, img in enumerate(images, 1):
        fed = V.downscaled(img, cache)
        t0 = time.time()
        ocr = step(P_OCR, image=fed)                 # 1) OCR
        a_zh = step(PA_SUM.format(txt=ocr))           # A: 요약(번체)
        a_ko = step(PA_TRANS.format(txt=a_zh))        #    → 번역(한글)
        b_full = step(PB_TRANS.format(txt=ocr))       # B: 번역(한글)
        b_ko = step(PB_SUM.format(txt=b_full))        #    → 요약(한글)
        rows.append({
            "model": model, "image": os.path.basename(img), "ocr": ocr,
            "A_요약번체": a_zh, "A_최종한글": a_ko,
            "B_번역전문": b_full, "B_최종한글": b_ko,
            "seconds": round(time.time() - t0, 1),
        })
        with open(pfile, "w") as f:   # 게시물마다 저장
            json.dump(rows, f, ensure_ascii=False)
        print(f"  [{i}/{len(images)}] OCR:{ocr[:30]} | A:{a_ko[:24]} | B:{b_ko[:24]}")


def merge_and_report():
    rows = []
    for pf in sorted(glob.glob(os.path.join(OUT, "_p_*.json"))):
        d = json.load(open(pf))
        if d and d[0]["model"] in V.MODEL_INFO:
            rows.extend(d)
    json.dump(rows, open(f"{OUT}/compare.json", "w"), ensure_ascii=False, indent=2)
    import csv
    cols = ["model", "image", "ocr", "A_요약번체", "A_최종한글", "B_번역전문", "B_최종한글", "seconds"]
    with open(f"{OUT}/compare.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    # 게시물별로 모델 A/B 묶어 보기
    by = {}
    for r in rows:
        by.setdefault(r["image"], []).append(r)
    L = ["# 파이프라인 순서 비교 — A(요약→번역) vs B(번역→요약)\n",
         f"게시물 {len(by)}개 × 모델 {len(set(r['model'] for r in rows))}개\n"]
    for img in sorted(by):
        L.append(f"\n## {img}")
        L.append(f"- OCR(번체): {by[img][0]['ocr']}")
        L.append("\n| 모델 | A (요약→번역) | B (번역→요약) |")
        L.append("|---|---|---|")
        for r in by[img]:
            L.append(f"| {r['model'].split('/')[-1][:22]} | {r['A_최종한글'][:30]} | {r['B_최종한글'][:30]} |")
    open(f"{OUT}/compare.md", "w").write("\n".join(L) + "\n")
    print(f"\n저장: {OUT}/compare.md, compare.csv")


def main():
    args = sys.argv[1:]
    only = child = None
    if "--child" in args:
        args.remove("--child"); child = True
    if "--only" in args:
        i = args.index("--only"); only = resolve(args[i + 1]); args = args[:i] + args[i + 2:]
    n = int(args[0]) if args else 5

    os.makedirs(OUT, exist_ok=True)
    images = V.pick_images("test-images", n)

    if only:  # 모델 1개
        if os.path.exists(partial_path(only)):
            os.remove(partial_path(only))
        run_one(only, images)
        if not child:
            merge_and_report()
        return

    # 전체: 모델마다 별도 프로세스
    print(f"A/B 파이프라인 비교: 모델 {len(MODELS)}개 × 게시물 {len(images)}개")
    for mdl in MODELS:
        print(f"\n=== {mdl} ===")
        p = subprocess.run([sys.executable, os.path.abspath(__file__),
                            str(n), "--only", mdl, "--child"])
        if p.returncode != 0:
            print(f"  ⚠ 비정상 종료 — 스킵: {mdl}")
        merge_and_report()
    merge_and_report()


if __name__ == "__main__":
    main()
