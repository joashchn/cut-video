"""
FunASR API 封装模块

阿里云百炼 FunASR 录音文件识别
支持长音频（最长12小时，2GB）
"""

import os
import json
import subprocess
import tempfile
from typing import Optional, List
from dataclasses import dataclass
from enum import Enum

import requests
import dashscope
from dashscope.audio.asr import Transcription
from dashscope.api_entities.dashscope_response import TranscriptionResponse


class ModelType(Enum):
    """支持的模型类型"""
    FUN_ASR = "fun-asr"
    PARAFORMER_V1 = "paraformer-v1"
    PARAFORMER_V2 = "paraformer-v2"
    SENSE_VOICE = "sensevoice-v1"


# v2 模型使用 vocabulary_id，v1 使用 phrase_id
V2_MODELS = {ModelType.PARAFORMER_V2.value, "paraformer-v2"}


@dataclass
class TranscriptionResult:
    """转写结果"""
    text: str
    task_id: str
    task_status: str
    duration_seconds: Optional[float] = None
    sentences: Optional[List[dict]] = None  # 包含时间戳的句子列表


# 支持的视频文件扩展名
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm'}


def is_video_file(path: str) -> bool:
    """检查是否为视频文件"""
    ext = os.path.splitext(path.lower())[1]
    return ext in VIDEO_EXTENSIONS


def extract_audio_from_video(video_path: str, output_path: Optional[str] = None) -> str:
    """
    从视频文件提取 WAV 音频

    Args:
        video_path: 视频文件路径
        output_path: 输出音频路径，默认在同目录下生成同名 wav 文件

    Returns:
        提取的音频文件路径
    """
    if output_path is None:
        base = os.path.splitext(video_path)[0]
        output_path = base + ".wav"

    # 使用 ffmpeg 提取音频，转换为 16kHz 单声道 WAV
    cmd = [
        'ffmpeg',
        '-i', video_path,           # 输入视频
        '-vn',                        # 禁用视频
        '-acodec', 'pcm_s16le',      # 音频编码为 WAV
        '-ar', '16000',              # 采样率 16kHz
        '-ac', '1',                  # 单声道
        '-y',                         # 覆盖输出文件
        output_path
    ]

    print(f"正在提取音频: {video_path} -> {output_path}")
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise RuntimeError(f"音频提取失败: {result.stderr}")

    print(f"音频提取完成: {output_path}")
    return output_path


class FunASRTranscriber:
    """FunASR 录音文件识别封装

    使用流程:
    1. 如果是视频文件，自动提取音频
    2. 通过 Files.upload 上传音频文件
    3. 获取文件的访问 URL
    4. 提交转写任务
    5. 轮询获取结果（包含 transcription_url）
    6. 从 transcription_url 获取最终文本
    """

    def __init__(self, api_key: Optional[str] = None):
        """
        初始化

        Args:
            api_key: 阿里云百炼 API Key，不传则从 DASHSCOPE_API_KEY 环境变量读取
        """
        self.api_key = api_key or os.getenv("DASHSCOPE_API_KEY")
        if not self.api_key:
            raise ValueError(
                "API key 未设置，请设置 DASHSCOPE_API_KEY 环境变量 "
                "或传入 api_key 参数"
            )
        dashscope.api_key = self.api_key

    def _upload_file(self, file_path: str) -> str:
        """
        上传文件到百炼存储

        Args:
            file_path: 本地文件路径

        Returns:
            文件的 OSS URL
        """
        from dashscope import Files

        resp = Files.upload(
            file_path=file_path,
            purpose='inference',
            description='audio file for ASR'
        )

        if resp.status_code != 200:
            raise RuntimeError(f"文件上传失败: {resp.code} {resp.message}")

        # 从响应中获取文件 URL
        output = resp.output if hasattr(resp, 'output') else resp
        uploaded_files = output.get('uploaded_files', [])
        if not uploaded_files:
            raise RuntimeError(f"文件上传失败: 未获取到文件信息")

        file_id = uploaded_files[0].get('file_id')

        # 获取文件的完整 URL
        file_info = Files.get(file_id)
        file_url = file_info.output.get('url')

        return file_url

    def _get_transcription_text(self, transcription_url: str) -> tuple:
        """
        从 transcription_url 获取转写文本和时间戳

        Args:
            transcription_url: 转写结果 URL

        Returns:
            (转写文本, 句子列表(含时间戳), 音频时长)
        """
        resp = requests.get(transcription_url)
        if resp.status_code != 200:
            raise RuntimeError(
                f"获取转写结果失败: HTTP {resp.status_code}"
            )

        data = resp.json()

        # 提取所有文本
        texts = []
        all_sentences = []
        for transcript in data.get('transcripts', []):
            for sentence in transcript.get('sentences', []):
                texts.append(sentence['text'])
                sentence_data = {
                    "text": sentence['text'],
                    "begin_time": sentence.get('begin_time', 0),
                    "end_time": sentence.get('end_time', 0),
                    "words": []  # 词级时间戳
                }
                # 解析词级时间戳
                for word in sentence.get('words', []):
                    sentence_data["words"].append({
                        "text": word.get('text', ''),
                        "begin_time": word.get('begin_time', 0),
                        "end_time": word.get('end_time', 0),
                    })
                all_sentences.append(sentence_data)

        # 获取音频时长
        duration = data.get('properties', {}).get(
            'original_duration_in_milliseconds', 0
        ) / 1000

        return ''.join(texts), all_sentences, duration

    def transcribe(
        self,
        audio_or_video_path: str,
        model: ModelType = ModelType.PARAFORMER_V1,
        poll_interval: int = 5,
        language: Optional[str] = None,
        output_audio_path: Optional[str] = None,
        phrase_id: Optional[str] = None,
        vocabulary_id: Optional[str] = None,
    ) -> TranscriptionResult:
        """
        转写音频或视频文件

        Args:
            audio_or_video_path: 本地音频或视频文件路径
            model: 模型类型
            poll_interval: 轮询间隔（秒）
            language: 语言提示，如 "zh", "en"
            output_audio_path: 视频提取音频时的输出路径，默认在同目录生成 wav

        Returns:
            TranscriptionResult 对象
        """
        input_path = audio_or_video_path

        # 如果是视频文件，先提取音频
        if is_video_file(input_path):
            input_path = extract_audio_from_video(input_path, output_audio_path)

        if not os.path.exists(input_path):
            raise FileNotFoundError(f"文件不存在: {input_path}")

        print(f"正在上传文件: {input_path}")

        # Step 1: 上传文件
        file_url = self._upload_file(input_path)
        print(f"文件上传完成")

        # Step 2: 提交转写任务
        print(f"正在提交转写任务 (模型: {model.value})...")
        kwargs = {
            "timestamp_alignment_enabled": True,   # 开启时间戳
            "disfluency_removal_enabled": True,  # 开启语气词过滤
        }
        # v2 模型使用 vocabulary_id，v1 使用 phrase_id
        if vocabulary_id and model.value in V2_MODELS:
            kwargs["vocabulary_id"] = vocabulary_id
        elif phrase_id:
            kwargs["phrase_id"] = phrase_id

        task_response = Transcription.async_call(
            model=model.value,
            file_urls=[file_url],
            **kwargs,
        )

        if not hasattr(task_response, 'output') or not hasattr(
            task_response.output, 'task_id'
        ):
            raise RuntimeError(f"提交任务失败: {task_response}")

        task_id = task_response.output.task_id
        print(f"任务已提交，task_id: {task_id}")

        # Step 3: 轮询获取结果
        print("等待转写完成（这可能需要几分钟）...")
        result = Transcription.wait(task=task_id)

        if result.output.task_status != 'SUCCEEDED':
            raise RuntimeError(
                f"转写失败: {result.output.get('code')} "
                f"{result.output.get('message')}"
            )

        # Step 4: 从 transcription_url 获取最终文本
        results = result.output.get('results', [])
        if not results:
            raise RuntimeError("转写结果为空")

        transcription_url = results[0].get('transcription_url')
        if not transcription_url:
            raise RuntimeError("未获取到转写结果 URL")

        text, sentences, duration = self._get_transcription_text(transcription_url)

        return TranscriptionResult(
            text=text,
            task_id=task_id,
            task_status=result.output.task_status,
            duration_seconds=duration,
            sentences=sentences,
        )


def transcribe_audio(
    audio_file_path: str,
    api_key: Optional[str] = None,
    model: ModelType = ModelType.PARAFORMER_V1,
) -> str:
    """
    便捷函数：转写单个音频文件

    Args:
        audio_file_path: 本地音频文件路径
        api_key: API Key
        model: 模型类型

    Returns:
        转写文本
    """
    transcriber = FunASRTranscriber(api_key=api_key)
    result = transcriber.transcribe(audio_file_path, model=model)
    return result.text
