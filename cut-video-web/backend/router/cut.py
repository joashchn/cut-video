"""
视频剪辑 API
"""

import uuid
from pathlib import Path
from typing import Optional

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


class ExportRequest(BaseModel):
    """导出请求"""
    sentences: list  # 当前 sentences 数据（用于计算保留段和生成字幕）
    burn_subtitles: bool = False  # 是否烧录字幕


class ExportResponse(BaseModel):
    """导出响应"""
    output_id: str
    output_filename: str
    subtitle_filename: Optional[str] = None
    message: str


@router.post("/export/{video_id}", response_model=ExportResponse)
async def export_video(video_id: str, request: ExportRequest):
    """
    导出最终视频

    直接从原始视频剪辑导出，可选烧录字幕
    """
    # 获取原视频路径
    video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'}
    video_files = [
        f for f in UPLOADS_DIR.glob(f"{video_id}_*")
        if f.suffix.lower() in video_extensions
    ]
    if not video_files:
        raise HTTPException(status_code=404, detail="视频不存在")

    input_path = str(video_files[0])

    try:
        cutter = VideoCutter(str(OUTPUTS_DIR))
        kept_segments = _build_kept_segments(request.sentences, cutter, video_id)

        # 检查是否所有词都被删除
        has_any_deleted = any(
            w.get("deleted", False)
            for sent in request.sentences
            for w in sent.get("words", [])
        )
        has_any_kept = any(
            not w.get("deleted", False) and w.get("type") != "silence"
            for sent in request.sentences
            for w in sent.get("words", [])
        )
        if has_any_deleted and not has_any_kept:
            raise HTTPException(status_code=400, detail="所有词都已删除，没有可保留内容")

        # 清理旧输出文件
        for old_file in OUTPUTS_DIR.glob(f"cut_{video_id}_*.mp4"):
            try:
                old_file.unlink()
            except OSError:
                pass
        for old_file in OUTPUTS_DIR.glob(f"cut_sub_{video_id}_*.mp4"):
            try:
                old_file.unlink()
            except OSError:
                pass

        # 剪辑视频
        cut_filename = f"cut_{video_id}_{uuid.uuid4().hex[:8]}.mp4"
        if kept_segments:
            cutter.cut_video(input_path, kept_segments, cut_filename)
        else:
            # 无删除，直接复制原视频
            import shutil
            shutil.copy2(input_path, str(OUTPUTS_DIR / cut_filename))

        cut_path = OUTPUTS_DIR / cut_filename

        if not request.burn_subtitles:
            return ExportResponse(
                output_id=video_id,
                output_filename=cut_filename,
                message="导出完成",
            )

        # 烧录字幕
        subtitle_gen = SubtitleGenerator(str(OUTPUTS_DIR))
        subtitle_filename = f"sub_{video_id}_{uuid.uuid4().hex[:8]}.srt"
        subtitle_gen.generate_srt(request.sentences, subtitle_filename, kept_segments)
        subtitle_path = OUTPUTS_DIR / subtitle_filename

        output_with_subs = f"cut_sub_{video_id}_{uuid.uuid4().hex[:8]}.mp4"
        cutter.burn_subtitles(str(cut_path), str(subtitle_path), output_with_subs)

        return ExportResponse(
            output_id=video_id,
            output_filename=output_with_subs,
            subtitle_filename=subtitle_filename,
            message="导出完成（含字幕）",
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _build_kept_segments(sentences: list, cutter: VideoCutter, video_id: str) -> list:
    """
    根据 sentences 构建 kept_segments（复用反向剔除逻辑）

    用于字幕时间戳映射
    """
    PADDING_MS = 30

    # 预处理：自动删除被删除词包围的静默标记
    for sentence in sentences:
        words = sentence.get("words", [])
        for i, word in enumerate(words):
            if word.get("type") == "silence" and not word.get("deleted", False):
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

    # 收集删除段
    deleted_ranges = []
    for sentence in sentences:
        for word in sentence.get("words", []):
            if word.get("deleted", False):
                deleted_ranges.append((word["begin_time"], word["end_time"]))

    if not deleted_ranges:
        return None  # 无删除，无需时间映射

    # 获取原始视频时长
    video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'}
    video_files = [
        f for f in UPLOADS_DIR.glob(f"{video_id}_*")
        if f.suffix.lower() in video_extensions
    ]
    if not video_files:
        return None

    video_duration_ms = int(cutter.get_duration(str(video_files[0])) * 1000)

    # 合并重叠删除段
    deleted_ranges.sort(key=lambda x: x[0])
    merged_deleted = [deleted_ranges[0]]
    for curr in deleted_ranges[1:]:
        last = merged_deleted[-1]
        if curr[0] <= last[1] + PADDING_MS:
            merged_deleted[-1] = (last[0], max(last[1], curr[1]))
        else:
            merged_deleted.append(curr)

    # 构建补集
    kept_segments = []
    cursor = 0
    for del_start, del_end in merged_deleted:
        seg_start = cursor
        seg_end = max(cursor, del_start - PADDING_MS)
        if seg_end > seg_start:
            kept_segments.append((seg_start, seg_end))
        cursor = del_end + PADDING_MS

    if cursor < video_duration_ms:
        kept_segments.append((cursor, video_duration_ms))

    # 过滤无内容段
    filtered = []
    for seg_start, seg_end in kept_segments:
        seg_has_content = any(
            not w.get("deleted", False)
            and w.get("type") != "silence"
            and w["begin_time"] < seg_end
            and w["end_time"] > seg_start
            for sent in sentences
            for w in sent.get("words", [])
        )
        if seg_has_content:
            filtered.append((seg_start, seg_end))

    return filtered if filtered else None


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
