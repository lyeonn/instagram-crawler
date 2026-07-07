#!/usr/bin/env python3
# ver4 — 단계 분리 + 캡션/해시태그/분류 (A순서: 요약→번역), 3개 모델 (mlx)
#
# 1) OCR   : 사진 → 번체 원문 (워터마크 제외)
# 2) 요약   : OCR+캡션+해시태그 → 번체 제목 (보일러플레이트 무시·고유명사 유지·복붙금지)
# 3) 번역   : 번체 제목 → 순수 한국어 (한자 금지)
# 4) 분류   : → category 1개
#
# 모델마다 별도 프로세스. 결과 누적.
#
# 실행:
#   source ../.venv-vl/bin/activate
#   python scripts/vl_stage.py            # 3모델 × 게시물 5개
#   python scripts/vl_stage.py 15         # 게시물 15개
#   python scripts/vl_stage.py 5 --only 1 # 1번 모델만
#   python scripts/vl_stage.py --report   # 리포트만 재생성

import sys
import os
import json
import time
import glob
import subprocess

sys.path.insert(0, "scripts")
import vl_compare as V  # pick_images / downscaled / load_captions / split_hashtags / zh_script

MODELS = [
    "lmstudio-community/Qwen3.5-9B-MLX-4bit",            # 1순위
    "mlx-community/Qwen3-VL-8B-Instruct-8bit",          # 2순위
    "lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit",  # 3순위
]
OUT = "vl_results/ver4"
MAX_TOK = 256
CATEGORIES = "상품홍보 / 할인프로모션 / 이벤트팝업 / 아이돌소식 / 구매안내 / 기타"

P_OCR = ("이미지에 인쇄된 본문 글자를 번체중문(繁體) 그대로 추출해라. "
         "브랜드 로고·워터마크(VEASLY, Aisely)는 제외하고 본문만. 다른 말 없이 글자만 출력.")
P_SUM = (
    "너는 대만 타겟 한국 상품 대리구매(VEASLY) 인스타 게시물을 분석한다.\n"
    "아래 [OCR]·[캡션]·[해시태그]로 '이 게시물만의' 핵심 주제를 번체중문 한 줄 제목으로 요약해라.\n\n"
    "[OCR]\n{ocr}\n\n[캡션]\n{caption}\n\n[해시태그]\n{hashtags}\n\n"
    "규칙:\n"
    "1. 캡션의 공통 홍보문구(모든 한국상품 VEASLY 구매가능, 韓國代購 사이트, 적립·무료배송)는 "
    "제목에 쓰지 마라.\n"
    "2. 고유 단서 우선: 고유 해시태그(예 #cortis)·인물·브랜드·상품명. 일반 태그는 무시.\n"
    "3. OCR을 그대로 복붙하지 말고 15자 내외로 압축. 단 고유명사는 유지.\n"
    "4. 번체(繁體)로만, 간체(简体) 금지.\n"
    "번체 제목만 출력:"
)
P_TRANS = (
    "다음 번체중문 제목을 한국어로 번역해라.\n"
    "① 반드시 한국어로만 — 한자·번체·중국어를 단 한 글자도 남기지 마라.\n"
    "② 고유명사(인물/브랜드)는 한국어 표기로 옮겨라.\n"
    "한국어 제목만 출력:\n{txt}"
)
P_CAT = (
    f"다음 제목을 아래 분류 중 정확히 하나로만 답해라. 분류: {CATEGORIES}\n"
    "제목: {ko}\n분류명 하나만 출력:"
)


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


# ── 자식: 모델 1개로 4단계 ─────────────────────────────────────
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

    captions = V.load_captions()
    pfile = partial_path(model)
    rows = []
    for i, img in enumerate(images, 1):
        fed = V.downscaled(img, V.RESIZE_CACHE)
        cap = captions.get(os.path.basename(img), "")
        spec, gen = V.split_hashtags(cap)
        htxt = ("고유: " + (" ".join("#" + t for t in spec) or "(없음)") + " / "
                "일반(무시): " + (" ".join("#" + t for t in gen) or "(없음)"))
        t0 = time.time()
        ocr = step(P_OCR, image=fed)                                  # 1) OCR
        zh = step(P_SUM.format(ocr=ocr, caption=cap[:400] or "(없음)", hashtags=htxt))  # 2) 요약(번체)
        ko = step(P_TRANS.format(txt=zh))                             # 3) 번역(한글)
        cat = step(P_CAT.format(ko=ko)).split()[0] if ko else ""      # 4) 분류
        rows.append({
            "model": model, "image": os.path.basename(img),
            "ocr": ocr, "topic_zh": zh, "topic_ko": ko, "category": cat,
            "ok": bool(ko.strip()), "tok_per_s": None,
            "seconds": round(time.time() - t0, 1),
            "caption": cap.split("\n")[0][:50],
        })
        with open(pfile, "w") as f:
            json.dump(rows, f, ensure_ascii=False)
        print(f"  [{i}/{len(images)}] {cat:6} {ko[:34]}")


# ── 합본 + 리포트 ──────────────────────────────────────────────
def collect():
    rows = []
    for pf in sorted(glob.glob(os.path.join(OUT, "_p_*.json"))):
        d = json.load(open(pf))
        if d and d[0]["model"] in MODELS:
            rows.extend(d)
    return rows


def report(rows):
    import csv
    for r in rows:
        r["번체판정"] = {"trad": "번체", "simp": "간체섞임", "": ""}[V.zh_script(r.get("topic_zh", ""))]
    json.dump(rows, open(f"{OUT}/results.json", "w"), ensure_ascii=False, indent=2)
    cols = ["model", "image", "category", "topic_ko", "topic_zh", "번체판정", "ocr", "caption", "seconds"]
    with open(f"{OUT}/results.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader(); w.writerows(rows)

    # 모델별 요약 (번체율 = topic_zh 기준)
    scols = ["model", "성공", "번체율%", "평균초"]
    out = []
    for mdl in MODELS:
        r = [x for x in rows if x["model"] == mdl]
        if not r:
            out.append({"model": mdl.split("/")[-1], "성공": "미실행"}); continue
        trad = sum(1 for x in r if V.zh_script(x.get("topic_zh", "")) == "trad")
        zt = sum(1 for x in r if V.zh_script(x.get("topic_zh", "")))
        sec = [x["seconds"] for x in r if x.get("seconds")]
        out.append({"model": mdl.split("/")[-1], "성공": f"{sum(1 for x in r if x['ok'])}/{len(r)}",
                    "번체율%": round(trad / zt * 100) if zt else "-",
                    "평균초": round(sum(sec) / len(sec), 1) if sec else "-"})
    with open(f"{OUT}/summary.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=scols, extrasaction="ignore")
        w.writeheader(); w.writerows(out)

    # 게시물별 md
    by = {}
    for r in rows:
        by.setdefault(r["image"], []).append(r)
    L = ["# ver4 — 단계분리 + 캡션/해시태그/분류 (A순서)\n",
         f"게시물 {len(by)}개 × 모델 {len(set(r['model'] for r in rows))}개\n"]
    for img in sorted(by):
        L.append(f"\n## {img}")
        L.append(f"- OCR: {by[img][0]['ocr'][:70]}")
        L.append("\n| 모델 | 분류 | 한글 제목 | 번체 제목 | 판정 |")
        L.append("|---|---|---|---|---|")
        for r in by[img]:
            L.append(f"| {r['model'].split('/')[-1][:18]} | {r['category']} | "
                     f"{r['topic_ko'][:30]} | {r['topic_zh'][:24]} | {r['번체판정']} |")
    open(f"{OUT}/REPORT.md", "w").write("\n".join(L) + "\n")
    print(f"\n저장: {OUT}/REPORT.md, results.csv, summary.csv")


def main():
    args = sys.argv[1:]
    os.makedirs(OUT, exist_ok=True)
    if "--report" in args:
        report(collect()); return
    only = child = None
    if "--child" in args:
        args.remove("--child"); child = True
    if "--only" in args:
        i = args.index("--only"); only = resolve(args[i + 1]); args = args[:i] + args[i + 2:]
    n = int(args[0]) if args else 5
    images = V.pick_images("test-images", n)

    if only:
        if os.path.exists(partial_path(only)):
            os.remove(partial_path(only))
        run_one(only, images)
        if not child:
            report(collect())
        return

    print(f"ver4 단계분리: 모델 {len(MODELS)}개 × 게시물 {len(images)}개")
    for mdl in MODELS:
        print(f"\n=== {mdl} ===")
        p = subprocess.run([sys.executable, os.path.abspath(__file__),
                            str(n), "--only", mdl, "--child"])
        if p.returncode != 0:
            print(f"  ⚠ 비정상 종료 — 스킵: {mdl}")
        report(collect())
    report(collect())


if __name__ == "__main__":
    main()
