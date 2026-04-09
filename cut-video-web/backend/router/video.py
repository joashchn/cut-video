"""
视频上传和 ASR 转写 API
"""

import os
import json
import uuid
import asyncio
from pathlib import Path
from typing import Optional
from enum import Enum

from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import BaseModel

import sys
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from src.transcriber import FunASRTranscriber, ModelType
from src.hotword import HotwordManager

router = APIRouter(prefix="/api", tags=["video"])

# 存储目录（基于 backend 目录）
BASE_DIR = Path(__file__).parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

# 转写状态存储（内存中）
transcription_status: dict[str, dict] = {}

# 视频文件扩展名（用于扫描恢复）
_VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"}


def restore_transcription_status():
    """
    启动时从 uploads/ 目录恢复已完成的转写状态

    扫描 *_result.json 恢复为 done 状态，
    扫描无 result.json 的视频文件标记为 error（中断的任务）。
    """
    restored = 0
    errored = 0

    # 收集所有已有 result.json 的 video_id
    done_ids: set[str] = set()

    for result_file in UPLOADS_DIR.glob("*_result.json"):
        video_id = result_file.name.split("_")[0]
        if video_id in transcription_status:
            continue  # 已存在则跳过

        try:
            with open(result_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            filename = data.get("filename", "")
            filepath = str(UPLOADS_DIR / filename) if filename else ""

            transcription_status[video_id] = {
                "status": StatusEnum.DONE,
                "filename": filename,
                "filepath": filepath,
                "task_id": data.get("task_id"),
                "error": None,
            }
            done_ids.add(video_id)
            restored += 1
        except Exception as e:
            print(f"[恢复] 解析 {result_file.name} 失败: {e}")

    # 扫描无 result.json 的视频文件，标记为 error
    for video_file in UPLOADS_DIR.iterdir():
        if video_file.suffix.lower() not in _VIDEO_EXTENSIONS:
            continue
        video_id = video_file.name.split("_")[0]
        if video_id in transcription_status or video_id in done_ids:
            continue
        # 检查是否有对应的 result.json
        result_path = UPLOADS_DIR / f"{video_id}_result.json"
        if not result_path.exists():
            transcription_status[video_id] = {
                "status": StatusEnum.ERROR,
                "filename": video_file.name,
                "filepath": str(video_file),
                "task_id": None,
                "error": "服务重启前任务未完成",
            }
            errored += 1

    if restored or errored:
        print(f"[恢复] 已恢复 {restored} 个已完成任务，{errored} 个中断任务")


class StatusEnum(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    DONE = "done"
    ERROR = "error"


class UploadResponse(BaseModel):
    video_id: str
    filename: str
    status: StatusEnum


class StatusResponse(BaseModel):
    video_id: str
    status: StatusEnum
    filename: Optional[str] = None
    task_id: Optional[str] = None
    error: Optional[str] = None


class TimestampsResponse(BaseModel):
    video_id: str
    filename: str
    duration: float
    sentences: list


@router.post("/upload", response_model=UploadResponse)
async def upload_video(file: UploadFile = File(...)):
    """
    上传视频文件并触发 ASR 转写

    默认使用配置：
    - 模型：paraformer-v1（热词效果更好）
    - 热词：使用项目内置 hotwords.json
    - 时间戳：词级精度
    """
    # 生成唯一 ID
    video_id = str(uuid.uuid4())[:8]

    # 保存文件
    filename = f"{video_id}_{file.filename}"
    filepath = UPLOADS_DIR / filename

    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)

    # 初始化状态
    transcription_status[video_id] = {
        "status": StatusEnum.PENDING,
        "filename": filename,
        "filepath": str(filepath),
        "task_id": None,
        "error": None,
    }

    # 后台触发转写
    asyncio.create_task(transcribe_video(video_id))

    return UploadResponse(
        video_id=video_id,
        filename=filename,
        status=StatusEnum.PENDING,
    )


async def transcribe_video(video_id: str):
    """
    后台执行 ASR 转写（默认 v1 + 热词 + 词级时间戳）
    """
    global transcription_status

    status = transcription_status.get(video_id)
    if not status:
        return

    try:
        # 更新状态为处理中
        transcription_status[video_id]["status"] = StatusEnum.PROCESSING

        # 获取 API Key
        api_key = os.getenv("DASHSCOPE_API_KEY")
        if not api_key:
            raise ValueError("DASHSCOPE_API_KEY 环境变量未设置")

        # 加载热词（默认使用项目根目录的 hotwords.json）
        hotword_path = project_root / "hotwords.json"
        phrase_id = None

        if hotword_path.exists():
            phrases = HotwordManager.load_from_file(str(hotword_path))
            # 使用 v1 模型 + 热词
            hotword_id = HotwordManager.create_phrases(
                phrases, model="paraformer-v1", api_key=api_key
            )
            phrase_id = hotword_id
            print(f"[{video_id}] 热词已创建，phrase_id: {phrase_id}")
        else:
            print(f"[{video_id}] 未找到热词文件，跳过热词")

        # 创建转写器
        transcriber = FunASRTranscriber(api_key=api_key)

        # 执行转写（v1 模型 + 热词 + 词级时间戳）
        result = transcriber.transcribe(
            audio_or_video_path=status["filepath"],
            model=ModelType.PARAFORMER_V1,  # v1 模型（热词效果更好）
            phrase_id=phrase_id,
        )

        # 保存转写结果
        result_data = {
            "video_id": video_id,
            "filename": status["filename"],
            "duration": result.duration_seconds,
            "sentences": result.sentences,
            "task_id": result.task_id,
        }

        result_path = UPLOADS_DIR / f"{video_id}_result.json"
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result_data, f, ensure_ascii=False, indent=2)

        # 更新状态
        transcription_status[video_id]["status"] = StatusEnum.DONE
        transcription_status[video_id]["task_id"] = result.task_id

        print(f"[{video_id}] 转写完成，{len(result.sentences)} 个句子")

    except Exception as e:
        error_msg = str(e)
        print(f"[{video_id}] 转写失败: {error_msg}")
        transcription_status[video_id]["status"] = StatusEnum.ERROR
        transcription_status[video_id]["error"] = error_msg


@router.get("/status/{video_id}", response_model=StatusResponse)
async def get_status(video_id: str):
    """获取转写状态"""
    status = transcription_status.get(video_id)
    if not status:
        raise HTTPException(status_code=404, detail="视频不存在")

    return StatusResponse(
        video_id=video_id,
        status=status["status"],
        filename=status.get("filename"),
        task_id=status.get("task_id"),
        error=status.get("error"),
    )


@router.get("/timestamps/{video_id}", response_model=TimestampsResponse)
async def get_timestamps(video_id: str):
    """获取词级时间戳数据"""
    status = transcription_status.get(video_id)
    if not status:
        raise HTTPException(status_code=404, detail="视频不存在")

    if status["status"] != StatusEnum.DONE:
        raise HTTPException(
            status_code=400,
            detail=f"转写尚未完成，当前状态: {status['status']}"
        )

    result_path = UPLOADS_DIR / f"{video_id}_result.json"
    if not result_path.exists():
        raise HTTPException(status_code=404, detail="转写结果不存在")

    with open(result_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    return TimestampsResponse(
        video_id=video_id,
        filename=data["filename"],
        duration=data["duration"],
        sentences=data["sentences"],
    )


@router.get("/video/{video_id}")
async def get_video(video_id: str):
    """获取视频文件"""
    status = transcription_status.get(video_id)
    if not status:
        raise HTTPException(status_code=404, detail="视频不存在")

    filepath = status["filepath"]
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="视频文件不存在")

    return FileResponse(
        filepath,
        media_type="video/mp4",
        filename=status["filename"],
    )
