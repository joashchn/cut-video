"""
视频剪辑 API
"""

import os
import json
import uuid
from pathlib import Path
from typing import List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import sys
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from ..service.cutter import VideoCutter
from ..service.subtitle import SubtitleGenerator

router = APIRouter(prefix="/api", tags=["cut"])

# 存储目录（基于 backend 目录）
BASE_DIR = Path(__file__).parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
OUTPUTS_DIR = BASE_DIR / "outputs"
OUTPUTS_DIR.mkdir(exist_ok=True)


class CutRequest(BaseModel):
    """剪辑请求"""
    sentences: list  # 更新了 deleted 状态的 sentences 数据
    burn_subtitles: bool = False  # 是否烧录字幕


class CutResponse(BaseModel):
    """剪辑响应"""
    output_id: str
    output_filename: str
    subtitle_filename: Optional[str] = None  # 字幕文件名（烧录时返回）
    message: str


class WordDeleteRequest(BaseModel):
    """词删除请求"""
    video_id: str
    deleted_indices: List[int]  # 要删除的词的全局索引


@router.post("/cut/{video_id}", response_model=CutResponse)
async def cut_video(video_id: str, request: CutRequest):
    """
    根据删除的词剪辑视频

    请求体包含更新了 deleted 状态的 sentences 数据
    """
    # 获取原视频路径（排除 .wav 音频和 _result.json）
    video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'}
    video_files = [
        f for f in UPLOADS_DIR.glob(f"{video_id}_*")
        if f.suffix.lower() in video_extensions
    ]

    if not video_files:
        raise HTTPException(status_code=404, detail="视频不存在")

    input_path = str(video_files[0])

    try:
        # 执行剪辑
        output_filename = f"cut_{video_id}_{uuid.uuid4().hex[:8]}.mp4"
        output_path = OUTPUTS_DIR / output_filename

        # 使用 cutter 服务
        cutter = VideoCutter(str(OUTPUTS_DIR))

        # 按连续保留词组构建 kept_segments
        # 不再逐词收集独立时间点，避免词间自然间隙导致片段断裂
        PADDING_MS = 30  # 边界填充，应对 ASR 时间戳偏差
        kept_segments = []

        for sentence in request.sentences:
            words = sentence.get("words", [])
            run_start = None
            run_end = None

            for word in words:
                if not word.get("deleted", False):
                    if run_start is None:
                        run_start = word["begin_time"]
                    run_end = word["end_time"]
                else:
                    # 遇到删除的词，结束当前连续段
                    if run_start is not None:
                        kept_segments.append((
                            max(0, run_start - PADDING_MS),
                            run_end + PADDING_MS,
                        ))
                        run_start = None
                        run_end = None

            # 句子结束，收尾当前连续段
            if run_start is not None:
                kept_segments.append((
                    max(0, run_start - PADDING_MS),
                    run_end + PADDING_MS,
                ))

        if not kept_segments:
            raise HTTPException(status_code=400, detail="所有词都被删除，没有保留内容")

        cutter.cut_video(input_path, kept_segments, output_filename)

        subtitle_filename = None
        if request.burn_subtitles:
            # 生成字幕文件（传递 kept_segments 以计算相对时间戳）
            subtitle_gen = SubtitleGenerator(str(OUTPUTS_DIR))
            subtitle_filename = f"sub_{video_id}_{uuid.uuid4().hex[:8]}.srt"
            subtitle_gen.generate_srt(request.sentences, subtitle_filename, kept_segments)
            subtitle_path = OUTPUTS_DIR / subtitle_filename

            # 烧录字幕到视频
            output_with_subs = f"cut_sub_{video_id}_{uuid.uuid4().hex[:8]}.mp4"
            cutter.burn_subtitles(str(output_path), str(subtitle_path), output_with_subs)
            output_filename = output_with_subs

        return CutResponse(
            output_id=video_id,
            output_filename=output_filename,
            subtitle_filename=subtitle_filename,
            message="剪辑完成",
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/download/{filename}")
async def download_video(filename: str):
    """下载剪辑后的视频"""
    output_path = OUTPUTS_DIR / filename

    if not output_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    return FileResponse(
        str(output_path),
        media_type="video/mp4",
        filename=filename,
    )


def _adjust_timestamps_for_edit(
    sentences: list,
    kept_segments: List[Tuple[int, int]],
) -> list:
    """
    调整时间戳到剪辑后视频的相对时间

    比如原始视频：
    - 词A: 0-1000ms
    - 词B: 1000-2000ms (删除)
    - 词C: 2000-3000ms

    剪辑后视频（删除了词B的时间段）：
    - 词A: 0-1000ms
    - 词C: 1000-2000ms (因为删除了1000-2000ms)

    这个函数计算每个保留词在剪辑后视频中的新时间位置。
    """
    if not kept_segments:
        return sentences

    # 构建原始时间 -> 相对时间的映射
    # 原理：对于每个保留词，找到它的结束时间在所有保留段时间中的累积位置
    adjusted_sentences = []

    for sentence in sentences:
        adjusted_sentence = {
            "text": sentence["text"],
            "begin_time": None,
            "end_time": None,
            "words": [],
        }

        for word in sentence.get("words", []):
            if word.get("deleted", False):
                continue

            orig_begin = word["begin_time"]
            orig_end = word["end_time"]

            # 计算这个时间点在剪辑后视频中的位置
            new_begin = _map_original_to_adjusted(orig_begin, kept_segments)
            new_end = _map_original_to_adjusted(orig_end, kept_segments)

            adjusted_word = {
                "text": word["text"],
                "begin_time": new_begin,
                "end_time": new_end,
                "deleted": False,
            }
            adjusted_sentence["words"].append(adjusted_word)

            # 更新句子的时间
            if adjusted_sentence["begin_time"] is None or new_begin < adjusted_sentence["begin_time"]:
                adjusted_sentence["begin_time"] = new_begin
            if adjusted_sentence["end_time"] is None or new_end > adjusted_sentence["end_time"]:
                adjusted_sentence["end_time"] = new_end

        if adjusted_sentence["words"]:
            adjusted_sentences.append(adjusted_sentence)

    return adjusted_sentences


def _map_original_to_adjusted(
    original_ms: int,
    kept_segments: List[Tuple[int, int]],
) -> int:
    """
    将原始视频的时间映射到剪辑后视频的相对时间

    例如原始视频保留段 [(0,2000), (4000,10000)]：
    - 0-2000ms -> 0-2000ms (第一保留段)
    - 2000-4000ms (gap，被删除)
    - 4000-10000ms -> 2000-8000ms (第二保留段，因为第一保留段贡献了2000ms)
    """
    for i, (start_ms, end_ms) in enumerate(kept_segments):
        if original_ms < start_ms:
            # 在当前保留段之前（gap 中）
            if i == 0:
                return original_ms
            # 累加前面所有保留段时间
            offset = sum(s2 - s1 for s1, s2 in kept_segments[:i])
            return offset
        elif start_ms <= original_ms <= end_ms:
            # 在当前保留段内
            if i == 0:
                return original_ms
            offset = sum(s2 - s1 for s1, s2 in kept_segments[:i])
            return offset + (original_ms - start_ms)
    # 超出所有保留段
    return sum(s2 - s1 for s1, s2 in kept_segments)


@router.get("/outputs")
async def list_outputs():
    """列出所有输出文件"""
    outputs = []
    for f in OUTPUTS_DIR.glob("cut_*.mp4"):
        outputs.append({
            "filename": f.name,
            "size": f.stat().st_size,
            "created": f.stat().st_mtime,
        })
    return {"outputs": outputs}
