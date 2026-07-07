#!/usr/bin/env python3
# 비전 모델 비교 러너 (mlx, Apple Silicon 전용)
#
# 같은 인스타 사진들을 여러 모델에 돌려서
#   {ocr, topic_zh, topic_ko} + 속도(tok/s) 를 한 표로 뽑는다.
#
# 실행:
#   source .venv-vl/bin/activate
#   python scripts/vl_compare.py            # test-images 에서 12장 샘플
#   python scripts/vl_compare.py 24         # 24장
#   python scripts/vl_compare.py 24 ./test-images   # 장수 + 폴더 지정
#
# 구조: 모델마다 "별도 프로세스"로 돌린다. InternVL 처럼 GPU 타임아웃으로
#       네이티브 abort(파이썬 try/except 로 못 잡음)가 나도, 그 모델만
#       건너뛰고 나머지는 계속된다. 각 모델 결과는 끝나는 즉시 저장.
#
# 결과:
#   vl_results/results.json   (전체 raw)
#   vl_results/results.csv    (엑셀/시트로 비교, utf-8-sig 라 안 깨짐)

import sys
import os
import json
import time
import glob
import re
import subprocess

# ──────────────────────────────────────────────────────────────
# 비교 모델 + 스펙(리포트용). 빼려면 그 항목 줄 앞에 # 붙이면 됨.
# mem: 24GB 맥 기준 대략치. ✅안전 / ⚠️빠듯(OOM위험)
MODEL_INFO = {
    "mlx-community/Qwen3-VL-8B-Instruct-8bit": {
        "company": "Alibaba", "params": "8B", "quant": "8bit", "mem": "~9GB ✅",
        "desc": "Qwen3-VL 비전 전용. 기존 비교 챔피언(번체 출력 검증됨)."},
    "mlx-community/InternVL3-8B-8bit": {
        "company": "Shanghai AI Lab", "params": "8B", "quant": "8bit", "mem": "~9GB ✅",
        "desc": "InternVL 계열. 문서·차트 OCR 강점. GPU 타임아웃 잦음."},
    "lmstudio-community/Qwen3.5-9B-MLX-4bit": {
        "company": "Alibaba", "params": "9B", "quant": "4bit", "mem": "~5GB ✅",
        "desc": "Qwen 신세대 경량 멀티모달."},
    "mlx-community/gemma-4-12B-it-qat-4bit": {
        "company": "Google", "params": "12B", "quant": "4bit(QAT)", "mem": "~7GB ✅",
        "desc": "구글 Gemma. QAT라 4bit인데도 품질 보존."},
    "lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit": {
        "company": "Google", "params": "26B(MoE/A4B)", "quant": "4bit(QAT)", "mem": "~14GB ⚠️",
        "desc": "Gemma MoE(활성 4B). 덩치 크지만 빠른 편. 24GB 빠듯."},
    # Qwen3.6-27B(통짜)는 24GB에서 시스템 다운 발생 → 비교 대상에서 제외(하드웨어 한계).
}
MODELS = list(MODEL_INFO.keys())

# 캡션 + 해시태그를 같이 넣는다. 출력 = 제목(번체/한국어) + 분류 태그.
CATEGORIES = "상품홍보 / 할인프로모션 / 이벤트팝업 / 아이돌소식 / 구매안내 / 기타"
# 거의 모든 게시물에 붙는 일반 해시태그(이건 제목 단서로 쓰지 않음).
GENERIC_TAGS = {
    "韓國代購", "韓國", "香港韓國代購", "代購", "韓国", "台灣代購", "台灣", "台湾",
    "韓貨", "空運", "韓國空運", "韓妞", "韓系", "veasly", "韓國商品",
}
PROMPT_TMPL = (
    "너는 대만 타겟 한국 상품 대리구매(VEASLY) 인스타그램 게시물을 분석한다.\n"
    "[캡션]·[해시태그]·[이미지]를 함께 보고 '이 게시물만의' 핵심 주제를 한 줄 제목으로 만들어라.\n\n"
    "[캡션]\n{caption}\n\n"
    "[해시태그]\n{hashtags}\n\n"
    "규칙:\n"
    "1. 캡션에는 모든 게시물에 똑같이 붙는 홍보문구가 있다(예: '모든 한국 상품·아이돌 굿즈는 "
    "VEASLY에서 구매 가능', '韓國代購 사이트', 포인트 적립·무료배송 안내). 이건 일반 문구이므로 "
    "제목에 절대 쓰지 마라. (\"VEASLY 한국 대리구매 안내\" 같은 제목은 실패다)\n"
    "2. 대신 '이 게시물만의 고유 주제'를 잡아라. 단서 우선순위: ① 고유 해시태그(아이돌/상품/브랜드명, "
    "예 #cortis) ② 캡션 첫 줄 ③ 이미지 내용.\n"
    "3. 제목 형식 = [고유 대상] + [무엇]. 예: 'CORTIS W매거진 화보', 'MUSINSA 블랙프라이데이 할인', "
    "'aespa 포토카드 공구'. 묘사('~하고 있다') 금지, 짧은 명사형(15~25자).\n"
    "4. ocr: 이미지 속 글자 그대로 추출(번체중문). 없으면 빈 문자열.\n"
    "5. topic_zh: 제목을 번체중문(繁體)으로. 간체(简体) 절대 금지.\n"
    "6. topic_ko: 같은 제목을 순수 한국어로(한자 섞지 말 것).\n"
    f"7. category: 다음 중 하나만 — {CATEGORIES}\n"
    "반드시 아래 JSON 형식으로만 답하라:\n"
    '{{"ocr":"", "topic_zh":"", "topic_ko":"", "category":""}}'
)


def split_hashtags(caption):
    """캡션에서 해시태그 추출 → (고유 태그, 일반 태그)."""
    tags = re.findall(r"#(\S+)", caption or "")
    gen_lower = {g.lower() for g in GENERIC_TAGS}
    spec = [t for t in tags if t.lower() not in gen_lower]
    gen = [t for t in tags if t.lower() in gen_lower]
    return spec, gen

MAX_TOKENS = 512
MAX_SIDE = 1280   # 이미지 긴 변을 이 픽셀로 줄여 먹임 (GPU 타임아웃 방지 + 속도)
# 프롬프트 버전별로 결과 폴더를 나눈다 (ver1=옛 프롬프트, ver2=캡션+제목+분류).
# 새 프롬프트로 또 바꿀 땐 이 값만 "ver3" 등으로 올리면 됨.
VERSION = "ver3"
OUT_DIR = f"vl_results/{VERSION}"
RESIZE_CACHE = "vl_results/_resized"   # 리사이즈 이미지는 버전 공통(재작업 방지)
# ──────────────────────────────────────────────────────────────


def load_captions(folder="test-images"):
    """test-images/index.json 에서 파일명 -> 캡션 맵 로드 (없으면 빈 맵)."""
    p = os.path.join(folder, "index.json")
    if not os.path.exists(p):
        return {}
    try:
        return {x["file"]: x.get("caption", "") for x in json.load(open(p))}
    except Exception:  # noqa: BLE001
        return {}


def pick_images(folder, n):
    """최근 n개 '게시물'의 첫 사진을 고른다 (게시물당 1장). n<=0이면 전체 게시물.
    index.json 이 최신순이라, 게시물(mediaId)별 첫 등장 파일 = 대표(첫) 사진."""
    idx_path = os.path.join(folder, "index.json")
    if os.path.exists(idx_path):
        try:
            idx = json.load(open(idx_path))
        except Exception:  # noqa: BLE001
            idx = []
        first = {}  # mediaId -> 첫 사진 파일 (insertion order = 최신순)
        for x in idx:
            mid = x.get("mediaId")
            f = x.get("file")
            if mid and f and mid not in first:
                p = os.path.join(folder, f)
                if os.path.exists(p):
                    first[mid] = p
        files = list(first.values())
        if files:
            return files if n <= 0 else files[:n]
    # index.json 없으면 폴백: 그냥 .jpg 를 고루 샘플
    files = sorted(glob.glob(os.path.join(folder, "*.jpg")))
    if not files:
        sys.exit(f"이미지가 없다: {folder} (먼저 `npm run ig:images` 실행)")
    if n <= 0 or n >= len(files):
        return files
    stride = len(files) / n
    return [files[int(i * stride)] for i in range(n)]


def downscaled(path, cache_dir):
    """긴 변이 MAX_SIDE 넘으면 줄여서 임시 저장하고 그 경로 반환. 작으면 원본 그대로."""
    try:
        from PIL import Image
        im = Image.open(path).convert("RGB")
        w, h = im.size
        if max(w, h) <= MAX_SIDE:
            return path
        scale = MAX_SIDE / max(w, h)
        im = im.resize((int(w * scale), int(h * scale)))
        os.makedirs(cache_dir, exist_ok=True)
        out = os.path.join(cache_dir, os.path.basename(path))
        im.save(out, "JPEG", quality=90)
        return out
    except Exception:  # noqa: BLE001 — 리사이즈 실패하면 원본 사용
        return path


def extract_json(text):
    """모델 출력에서 JSON 덩어리만 뽑아 파싱. 실패하면 None."""
    t = text.strip()
    if "```" in t:  # ```json ... ``` 펜스 제거
        t = t.split("```")[1] if t.count("```") >= 2 else t
        t = t.replace("json", "", 1).strip() if t.lstrip().lower().startswith("json") else t
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(t[start: end + 1])
    except json.JSONDecodeError:
        return None


def partial_path(model_path):
    return os.path.join(OUT_DIR, "_partial_" + model_path.replace("/", "__") + ".json")


# ── 자식 프로세스: 모델 1개만 처리하고 partial 파일로 저장 ──────────────
def run_one(model_path, images):
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template

    print(f"\n▶ 로딩: {model_path}")
    t0 = time.time()
    model, processor = load(model_path, trust_remote_code=True)
    config = getattr(model, "config", None)
    print(f"  로드 완료 ({time.time() - t0:.0f}s). 게시물 {len(images)}개 처리...")

    cache = RESIZE_CACHE
    captions = load_captions()
    pfile = partial_path(model_path)
    rows = []
    for i, img in enumerate(images, 1):
        fed = downscaled(img, cache)
        cap_full = captions.get(os.path.basename(img), "")
        spec, gen = split_hashtags(cap_full)
        htxt = ("고유: " + (" ".join("#" + t for t in spec) or "(없음)") + "\n"
                "일반(무시): " + (" ".join("#" + t for t in gen) or "(없음)"))
        cap = (cap_full or "(캡션 없음)")[:500]
        text_prompt = PROMPT_TMPL.format(caption=cap, hashtags=htxt)
        prompt = apply_chat_template(processor, config, text_prompt, num_images=1)
        t1 = time.time()
        try:
            out = generate(model, processor, prompt, image=[fed],
                           max_tokens=MAX_TOKENS, verbose=False)
            text = out.text if hasattr(out, "text") else str(out)
            tps = getattr(out, "generation_tps", None)
        except Exception as e:  # noqa: BLE001
            text, tps = f"[ERROR] {e}", None
        dt = time.time() - t1
        parsed = extract_json(text)
        rows.append({
            "model": model_path,
            "image": os.path.basename(img),
            "seconds": round(dt, 1),
            "tok_per_s": round(tps, 1) if tps else None,
            "ok": parsed is not None,
            "ocr": (parsed or {}).get("ocr", ""),
            "topic_zh": (parsed or {}).get("topic_zh", ""),
            "topic_ko": (parsed or {}).get("topic_ko", ""),
            "category": (parsed or {}).get("category", ""),
            "caption": cap_full.split("\n")[0][:60],  # 캡션 첫 줄(검토 맥락용)
            "raw": text if parsed is None else "",
        })
        # 이미지마다 partial 저장 → 모델이 중간에 abort 나도 여기까진 보존
        with open(pfile, "w") as f:
            json.dump(rows, f, ensure_ascii=False)
        mark = "✓" if parsed else "✗"
        print(f"  [{i}/{len(images)}] {mark} {dt:4.1f}s  {(parsed or {}).get('topic_ko','')[:36]}")


def save(rows):
    """results.json + results.csv(줄별) + summary.csv(모델별 요약) 저장."""
    import csv
    for r in rows:  # 파생 컬럼: 번체/간체 자동 판정
        r.setdefault("caption", "")
        r["번체"] = {"trad": "번체", "simp": "간체", "": ""}[zh_script(r.get("topic_zh", ""))]
    with open(os.path.join(OUT_DIR, "results.json"), "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    # 줄별 raw (모델×게시물) — 시트에서 정렬·필터·피벗용
    cols = ["model", "image", "ok", "번체", "category", "topic_ko", "topic_zh",
            "seconds", "tok_per_s", "caption", "ocr"]
    with open(os.path.join(OUT_DIR, "results.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    write_summary(rows)


def write_summary(rows):
    """모델당 한 줄 요약 CSV — 발표 슬라이드용 지표 비교표."""
    import csv
    a = agg(rows)
    cols = ["model", "company", "params", "quant", "mem",
            "성공", "성공률%", "평균tok/s", "평균초/장", "번체율%"]
    out = []
    for m in MODELS:
        info = MODEL_INFO[m]
        base = {"model": m.split("/")[-1], "company": info["company"],
                "params": info["params"], "quant": info["quant"], "mem": info["mem"]}
        s = a[m]
        if not s:
            base["성공"] = "미실행"
        else:
            base.update({
                "성공": f"{s['ok']}/{s['n']}",
                "성공률%": round(s["ok"] / s["n"] * 100) if s["n"] else "",
                "평균tok/s": round(s["tps"], 1) if s["tps"] else "",
                "평균초/장": round(s["sec"], 1) if s["sec"] else "",
                "번체율%": round(s["trad_pct"]) if s["trad_pct"] is not None else "",
            })
        out.append(base)
    with open(os.path.join(OUT_DIR, "summary.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(out)


def merge_all():
    """_partial_*.json 중 현재 MODELS 에 있는 것만 합쳐 저장하고 rows 반환.
    (옛날에 돌린 다른 모델 partial 은 무시 → 리포트가 깔끔)"""
    rows = []
    for pf in sorted(glob.glob(os.path.join(OUT_DIR, "_partial_*.json"))):
        with open(pf) as f:
            data = json.load(f)
        if data and data[0]["model"] in MODEL_INFO:
            rows.extend(data)
    save(rows)
    return rows


# 간체(简体) 전용 글자 모음 — 이 글자가 보이면 "간체 섞임"으로 판정(휴리스틱).
# 대만 타겟이라 topic_zh 는 번체(繁體)여야 함.
SIMPLIFIED = set(
    "国华杂志这独气场专辑总动员优额运红卖补给样发货际购韩对说时来过继续点击图标书爱称为"
    "顺现风见类问题语种灵机会关闭门间习课组织结构务选择确认设备连网络资讯录纪术电脑视频"
    "页档报导览许质规则节庆贺礼宾馆饭铺盘营销价钱币业产链纹饰级态变换转载验据处个们么还"
    "应该觉学实难脸团积折现帮买卖钟乐丽们贵长开关闷闹间阵际陈际东车轻较辆运达进远违"
)


def zh_script(zh):
    """topic_zh 가 번체면 'trad', 간체 섞이면 'simp', 빈값이면 ''"""
    if not zh or not zh.strip():
        return ""
    return "simp" if any(c in SIMPLIFIED for c in zh) else "trad"


def agg(rows):
    """모델별 지표 집계: 성공률, 평균 tok/s, 평균 초, 번체율(%)"""
    out = {}
    for m in MODELS:
        r = [x for x in rows if x["model"] == m]
        if not r:
            out[m] = None
            continue
        tps = [x["tok_per_s"] for x in r if x["tok_per_s"]]
        sec = [x["seconds"] for x in r if x["seconds"]]
        zhs = [zh_script(x["topic_zh"]) for x in r]
        trad = sum(1 for z in zhs if z == "trad")
        zh_total = sum(1 for z in zhs if z)
        out[m] = {
            "n": len(r),
            "ok": sum(1 for x in r if x["ok"]),
            "tps": sum(tps) / len(tps) if tps else None,
            "sec": sum(sec) / len(sec) if sec else None,
            "trad_pct": (trad / zh_total * 100) if zh_total else None,
        }
    return out


def print_summary(rows):
    a = agg(rows)
    print("\n" + "=" * 72)
    print(f"{'모델':<42}{'성공':>6}{'tok/s':>8}{'초/장':>7}{'번체%':>7}")
    print("-" * 72)
    for m in MODELS:
        s = a[m]
        name = m.split("/")[-1][:40]
        if not s:
            print(f"{name:<42}{'(미실행)':>6}")
            continue
        tps = f"{s['tps']:.1f}" if s["tps"] else "-"
        sec = f"{s['sec']:.1f}" if s["sec"] else "-"
        trad = f"{s['trad_pct']:.0f}" if s["trad_pct"] is not None else "-"
        print(f"{name:<42}{s['ok']:>3}/{s['n']:<2}{tps:>8}{sec:>7}{trad:>7}")
    print("=" * 72)
    print(f"\n📄 포폴용 리포트: {OUT_DIR}/REPORT.md   |   원본: {OUT_DIR}/results.csv")


def report(rows):
    """포트폴리오용 비교 리포트(REPORT.md) 생성."""
    a = agg(rows)
    L = []
    L.append("# VLM 모델 비교 — 인스타 사진 번체 OCR & 주제 요약\n")
    L.append("> VEASLY(대만 타겟 한국 대리구매) 인스타 게시물 사진에서 **번체중문을 읽어 "
             "주제를 자동 생성**할 비전-언어 모델(VLM)을 선정하기 위한 비교.\n")

    L.append("\n## 평가 기준\n")
    L.append("| 기준 | 왜 중요한가 | 측정 |")
    L.append("|---|---|---|")
    L.append("| **번체 출력** | 대만 타겟 — 간체로 나오면 사용 불가 | 번체율 %(자동) |")
    L.append("| **지시 준수** | JSON 형식·한국어 칸 준수 | 성공률(자동) |")
    L.append("| **OCR·요약 품질** | 실제 쓸 만한 결과인가 | 샘플 정성평가 |")
    L.append("| **속도** | 수백 장 배치 처리 시간 | tok/s, 초/장(자동) |")
    L.append("| **자원** | 24GB 맥에서 도는가 | 메모리 추정 |")
    L.append("| **안정성** | 크래시·OOM 없이 끝까지 | 성공 건수 |")

    L.append("\n## 후보 모델\n")
    L.append("| 모델 | 회사 | 크기 | 양자화 | 메모리(24GB) | 설명 |")
    L.append("|---|---|---|---|---|---|")
    for m in MODELS:
        i = MODEL_INFO[m]
        L.append(f"| `{m.split('/')[-1]}` | {i['company']} | {i['params']} | "
                 f"{i['quant']} | {i['mem']} | {i['desc']} |")

    L.append("\n## 정량 결과\n")
    L.append("| 모델 | 성공률 | 평균 tok/s | 평균 초/장 | **번체율** |")
    L.append("|---|---|---|---|---|")
    for m in MODELS:
        s = a[m]
        name = m.split("/")[-1]
        if not s:
            L.append(f"| `{name}` | (미실행) | - | - | - |")
            continue
        tps = f"{s['tps']:.1f}" if s["tps"] else "-"
        sec = f"{s['sec']:.1f}" if s["sec"] else "-"
        trad = f"**{s['trad_pct']:.0f}%**" if s["trad_pct"] is not None else "-"
        L.append(f"| `{name}` | {s['ok']}/{s['n']} | {tps} | {sec} | {trad} |")
    L.append("\n> 번체율 = topic_zh 중 간체 글자가 안 섞인 비율(자동 판정, 휴리스틱). "
             "대만 타겟이므로 **높을수록 좋음**.\n")

    # 샘플 비교 (공통으로 결과 있는 이미지 3장)
    by = {}
    for r in rows:
        by.setdefault(r["image"], {})[r["model"]] = r
    done = [m for m in MODELS if a[m]]
    samples = [img for img in sorted(by) if all(m in by[img] for m in done)][:3]
    if samples and done:
        L.append("\n## 샘플 비교 (같은 사진, 모델별 출력)\n")
        for img in samples:
            L.append(f"\n**`{img}`**\n")
            L.append("| 모델 | 제목(번체) | 제목(한국어) | 분류 | 판정 |")
            L.append("|---|---|---|---|---|")
            for m in done:
                r = by[img][m]
                zh = (r["topic_zh"] or "").replace("|", "/")[:36]
                ko = (r["topic_ko"] or "").replace("|", "/")[:36]
                cat = (r.get("category") or "").replace("|", "/")[:12]
                z = zh_script(r["topic_zh"])
                mark = {"trad": "✅번체", "simp": "❌간체", "": "—"}[z]
                L.append(f"| {m.split('/')[-1][:24]} | {zh} | {ko} | {cat} | {mark} |")

    with open(os.path.join(OUT_DIR, "REPORT.md"), "w") as f:
        f.write("\n".join(L) + "\n")


def resolve(name):
    """--only 값이 숫자면 MODELS 목록의 N번째(1-based), 아니면 그대로 repo id."""
    if name.isdigit():
        idx = int(name) - 1
        if 0 <= idx < len(MODELS):
            return MODELS[idx]
        sys.exit(f"모델 번호 범위 밖: {name} (1~{len(MODELS)})")
    return name


def main():
    args = sys.argv[1:]
    os.makedirs(OUT_DIR, exist_ok=True)

    # 모델 안 돌리고 기존 결과로 리포트만 다시 생성
    if "--report" in args:
        rows = merge_all()
        report(rows)
        print_summary(rows)
        return

    only = child = None
    if "--child" in args:           # 부모가 띄운 자식 (병합/요약은 부모가 함)
        args.remove("--child")
        child = True
    if "--only" in args:
        i = args.index("--only")
        only = resolve(args[i + 1])
        args = args[:i] + args[i + 2:]
    n = int(args[0]) if args else 12
    folder = args[1] if len(args) > 1 else "test-images"
    images = pick_images(folder, n)

    # ── 모델 1개만 ── (사용자가 직접 --only, 또는 부모가 띄운 --child)
    if only:
        if os.path.exists(partial_path(only)):
            os.remove(partial_path(only))   # 이 모델 결과는 새로
        run_one(only, images)
        if not child:                       # 사용자가 직접 돌린 경우만 누적·리포트
            rows = merge_all()
            report(rows)
            print_summary(rows)
        return

    # ── 전체 (모델마다 별도 프로세스) ──
    print(f"비교: 모델 {len(MODELS)}개 × 게시물 {len(images)}개(첫 사진+캡션)  (모델마다 별도 프로세스)")
    for m in MODELS:
        print(f"\n=== {m} ===")
        proc = subprocess.run([sys.executable, os.path.abspath(__file__),
                               str(n), folder, "--only", m, "--child"])
        if proc.returncode != 0:
            print(f"  ⚠ 비정상 종료(code {proc.returncode}) — 부분결과만 수습하고 다음 모델로")
        merge_all()  # 모델 끝날 때마다 합본 갱신
    rows = merge_all()
    report(rows)
    print_summary(rows)


if __name__ == "__main__":
    main()
