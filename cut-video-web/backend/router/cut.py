"""
视频剪辑 API
"""

import os
import json
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import sys
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from ..service.cutter import cut_video_by_deleted_words, VideoCutter

router = APIRouter(prefix="/api", tags=["cut"])

# 存储目录（基于 backend 目录）
BASE_DIR = Path(__file__).parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
OUTPUTS_DIR = BASE_DIR / "outputs"
OUTPUTS_DIR.mkdir(exist_ok=True)


class CutRequest(BaseModel):
    """剪辑请求"""
    sentences: list  # 更新了 deleted 状态的 sentences 数据


class CutResponse(BaseModel):
    """剪辑响应"""
    output_id: str
    output_filename: str
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
    # 获取原视频路径
    video_files = list(UPLOADS_DIR.glob(f"{video_id}_*"))

    # 排除结果文件
    video_files = [f for f in video_files if not f.name.endswith("_result.json")]

    if not video_files:
        raise HTTPException(status_code=404, detail="视频不存在")

    input_path = str(video_files[0])

    try:
        # 执行剪辑
        output_filename = f"cut_{video_id}_{uuid.uuid4().hex[:8]}.mp4"
        output_path = OUTPUTS_DIR / output_filename

        # 使用 cutter 服务
        cutter = VideoCutter(str(OUTPUTS_DIR))
        kept_segments = []

        for sentence in request.sentences:
            for word in sentence.get("words", []):
                if not word.get("deleted", False):
                    kept_segments.append((word["begin_time"], word["end_time"]))

        if not kept_segments:
            raise HTTPException(status_code=400, detail="所有词都被删除，没有保留内容")

        cutter.cut_video(input_path, kept_segments, output_filename)

        return CutResponse(
            output_id=video_id,
            output_filename=output_filename,
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
