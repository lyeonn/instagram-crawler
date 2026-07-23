#!/usr/bin/env python3
# VLM 사이드카 — 사진 + 캡션 → 한국어 제목 (mlx)
#
# 핵심: mlx의 GPU 스트림은 "모델을 로드한 바로 그 스레드"에만 존재한다.
#       FastAPI 워커 스레드에서 추론하면 "no Stream(gpu) in current thread" 에러.
#       → 로드와 추론을 모두 '단일 전용 스레드(executor)'에서 수행해 해결.
#
# 실행:
#   source ../.venv-vl/bin/activate
#   sudo sysctl iogpu.wired_limit_mb=22000   # Gemma-26B(14GB) 위해
#   python scripts/vl_server.py              # http://127.0.0.1:8088

import sys
import os
import time
import tempfile
import asyncio
import urllib.request
import concurrent.futures
from typing import Optional

sys.path.insert(0, "scripts")
import vl_compare as V  # split_hashtags / downscaled / RESIZE_CACHE 재사용

from fastapi import FastAPI
from pydantic import BaseModel
from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template

MODEL = os.environ.get("VL_MODEL", "lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit")
MAX_TOK = 256

P_OCR = ("이미지에 인쇄된 본문 글자를 번체중문(繁體) 그대로 추출해라. "
         "브랜드 로고·워터마크(VEASLY, Aisely)는 제외하고 본문만. 다른 말 없이 글자만 출력.")
P_SUM = (
    "너는 대만 타겟 한국 상품 대리구매(VEASLY) 인스타 게시물을 분석한다.\n"
    "아래 [OCR]·[캡션]·[해시태그]로 '이 게시물만의' 핵심 주제를 번체중문 한 줄 제목으로 요약해라.\n\n"
    "[OCR]\n{ocr}\n\n[캡션]\n{caption}\n\n[해시태그]\n{hashtags}\n\n"
    "규칙:\n"
    "1. 캡션의 공통 홍보문구(모든 한국상품 VEASLY 구매가능, 韓國代購 사이트, 적립·무료배송)는 "
    "제목에 쓰지 마라.\n"
    "2. **제목에 '구매대행/대행/구매 가능/주문/대구매/代購/購買' 같은 판매·구매 단어를 절대 쓰지 마라.** "
    "이 게시물은 '무엇에 관한 콘텐츠인가'(인물·작품·이벤트·상품 그 자체)만 제목으로 삼아라.\n"
    "3. 고유 단서 우선: 고유 해시태그(예 #cortis)·인물·브랜드·상품명. 일반 태그는 무시.\n"
    "4. OCR 글자의 '겉모양'이 아니라 '의미'로 제목을 잡아라.\n"
    "5. OCR을 그대로 복붙하지 말고 15자 내외로 압축. 단 고유명사는 유지.\n"
    "6. 번체(繁體)로만, 간체(简体) 금지.\n"
    "번체 제목만 출력:"
)
P_TRANS = (
    "다음 번체중문 제목을 한국어로 번역해라.\n"
    "① 반드시 한국어로만 — 한자·번체·중국어를 단 한 글자도 남기지 마라.\n"
    "② 고유명사(인물/브랜드)는 한국어 표기로 옮겨라.\n"
    "한국어 제목만 출력:\n{txt}"
)


def clean(s):
    return (s or "").strip().strip('"').replace("\n", " ")


# VEASLY 게시물 캡션은 전부 동일한 홍보 템플릿이라, 그대로 요약에 넣으면
# 모델이 이미지 내용을 버리고 캡션(홍보문구)만 요약한다 → 모든 글이 같은 제목.
# 요약 단계에 넣기 전에 홍보 보일러플레이트 줄을 제거한다.
_PROMO_KW = (
    "VEASLY", "AISELY", "韓國代購", "代購", "代购", "購買連結", "购买链接",
    "免運", "免运", "累積點數", "累积点数", "折抵", "偶像周邊", "偶像周边",
    "所有韓國商品", "所有韩国商品", "指定金額", "留言", "購買", "购买",
)


def strip_promo(caption):
    """캡션에서 공통 홍보문구/해시태그 줄을 제거. 남는 고유 내용만 반환(없으면 '')."""
    kept = []
    for line in (caption or "").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if any(kw in s for kw in _PROMO_KW):
            continue
        kept.append(s)
    return "\n".join(kept)


# ── mlx 전용 단일 스레드: 로드와 추론을 모두 여기서 ──────────────
_ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
model = processor = config = None


def _load():
    global model, processor, config
    print(f"[vl_server] 모델 로딩: {MODEL} ...")
    t0 = time.time()
    model, processor = load(MODEL, trust_remote_code=True)
    config = getattr(model, "config", None)
    print(f"[vl_server] 로드 완료 ({time.time() - t0:.0f}s). 대기 중 → http://127.0.0.1:8088")


_ex.submit(_load).result()  # 로드 끝날 때까지 대기 (전용 스레드에서)

app = FastAPI()


def step(prompt_text, image=None):
    ni = 1 if image else 0
    prompt = apply_chat_template(processor, config, prompt_text, num_images=ni)
    if image:
        out = generate(model, processor, prompt, image=[image], max_tokens=MAX_TOK, verbose=False)
    else:
        out = generate(model, processor, prompt, max_tokens=MAX_TOK, verbose=False)
    return clean(out.text if hasattr(out, "text") else str(out))


def download(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.write(fd, data)
        os.close(fd)
        return path
    except Exception as e:  # noqa: BLE001
        print(f"[vl_server] 이미지 다운로드 실패: {e}")
        return None


def _infer(image_url, caption):
    """전용 스레드에서 실행 (로드한 스레드와 동일 → GPU 스트림 있음)."""
    if not image_url:
        return {"title_ko": "", "error": "no image_url"}
    img = download(image_url)
    if not img:
        return {"title_ko": "", "error": "download failed"}
    try:
        t0 = time.time()
        fed = V.downscaled(img, V.RESIZE_CACHE)
        spec, gen = V.split_hashtags(caption)
        htxt = ("고유: " + (" ".join("#" + t for t in spec) or "(없음)") + " / "
                "일반(무시): " + (" ".join("#" + t for t in gen) or "(없음)"))
        cap_clean = strip_promo(caption)                                          # 공통 홍보문구 제거
        ocr = step(P_OCR, image=fed)                                              # 1) OCR
        zh = step(P_SUM.format(ocr=ocr, caption=(cap_clean[:400] or "(없음)"), hashtags=htxt))  # 2) 요약(번체)
        ko = step(P_TRANS.format(txt=zh))                                         # 3) 번역(한국어)
        print(f"[vl_server] {time.time() - t0:.1f}s  {ko[:30]}")
        return {"title_ko": ko, "title_zh": zh, "ocr": ocr}
    finally:
        try:
            os.remove(img)
        except OSError:
            pass


class Req(BaseModel):
    image_url: Optional[str] = None
    caption: str = ""


@app.post("/analyze")
async def analyze(r: Req):
    # 추론을 전용 스레드(executor)로 보냄 → 동시 요청도 자동으로 한 줄로 직렬화
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_ex, _infer, r.image_url, r.caption)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8088)
