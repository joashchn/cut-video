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

        # === 反向剔除逻辑 ===
        # 保留整个视频，只移除用户明确删除的词对应的时间段
        # 这样静默时段（讲师操作、思考等）自然保留
        PADDING_MS = 30  # 边界填充，应对 ASR 时间戳偏差

        # 预处理：自动删除被删除词包围的静默标记
        # 例如 [word1(删)] [🔇] [word2(删)] → 静默标记也应被删除
        # 避免删除整句后留下静默时段的残留片段
        for sentence in request.sentences:
            words = sentence.get("words", [])
            for i, word in enumerate(words):
                if word.get("type") == "silence" and not word.get("deleted", False):
                    # 找到最近的前/后真实词，检查是否都已删除
                    prev_deleted = True
                    next_deleted = True
                    for j in range(i - 1, -1, -1):
                        if words[j].get("type") != "silence":
                            prev_deleted = words[j].get("deleted", False)
                            break
                    for j in range(i + 1, len(words)):
                        if words[j].get("type") != "silence":
                            next_deleted = words[j].get("deleted", False)
                            break
                    if prev_deleted and next_deleted:
                        word["deleted"] = True

        # 1. 收集所有被删除的时间段（包括自动删除的静默）
        deleted_ranges = []
        has_any_kept = False
        for sentence in request.sentences:
            for word in sentence.get("words", []):
                if word.get("deleted", False):
                    deleted_ranges.append((
                        word["begin_time"],
                        word["end_time"],
                    ))
                elif word.get("type") != "silence":
                    # 只有真实词（非静默）计为保留内容
                    has_any_kept = True

        if not has_any_kept:
            raise HTTPException(status_code=400, detail="所有词都被删除，没有保留内容")

        # 2. 如果没有删除任何词，直接复制原视频（无需剪辑）
        if not deleted_ranges:
            import shutil
            shutil.copy2(input_path, str(output_path))
        else:
            # 3. 获取视频总时长，构建 kept_segments（删除段的补集）
            video_duration_ms = int(cutter.get_duration(input_path) * 1000)

            # 合并重叠的删除段并排序
            deleted_ranges.sort(key=lambda x: x[0])
            merged_deleted = [deleted_ranges[0]]
            for curr in deleted_ranges[1:]:
                last = merged_deleted[-1]
                if curr[0] <= last[1] + PADDING_MS:
                    merged_deleted[-1] = (last[0], max(last[1], curr[1]))
                else:
                    merged_deleted.append(curr)

            # 构建补集：[0, del1.start], [del1.end, del2.start], ..., [delN.end, duration]
            kept_segments = []
            cursor = 0
            for del_start, del_end in merged_deleted:
                seg_start = cursor
                seg_end = max(cursor, del_start - PADDING_MS)
                if seg_end > seg_start:
                    kept_segments.append((seg_start, seg_end))
                cursor = del_end + PADDING_MS

            # 最后一段：从最后删除段结束到视频末尾
            if cursor < video_duration_ms:
                kept_segments.append((cursor, video_duration_ms))

            # 过滤：只保留包含真实保留词的段（移除被删除词之间的间隙残留）
            # 被删除词之间的小间隙（<500ms，无静默标记）不在 deleted_ranges 中，
            # 会变成小的 kept_segments，需要过滤掉
            filtered_segments = []
            for seg_start, seg_end in kept_segments:
                seg_has_content = any(
                    not w.get("deleted", False)
                    and w.get("type") != "silence"
                    and w["begin_time"] < seg_end
                    and w["end_time"] > seg_start
                    for sent in request.sentences
                    for w in sent.get("words", [])
                )
                if seg_has_content:
                    filtered_segments.append((seg_start, seg_end))
            kept_segments = filtered_segments

            if not kept_segments:
                raise HTTPException(status_code=400, detail="剪辑后没有保留内容")

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
