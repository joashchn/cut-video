"""
ffmpeg 视频剪辑服务

使用 concat demuxer 方式合并保留段
"""

import os
import subprocess
import tempfile
from pathlib import Path
from typing import List, Tuple


class VideoCutter:
    """视频剪辑器"""

    def __init__(self, output_dir: str = "outputs"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)

    def cut_video(
        self,
        input_path: str,
        kept_segments: List[Tuple[int, int]],
        output_filename: str,
    ) -> str:
        """
        根据保留时间段剪辑视频

        Args:
            input_path: 输入视频路径
            kept_segments: 保留时间段列表，每项为 (start_ms, end_ms)
            output_filename: 输出文件名

        Returns:
            输出视频路径
        """
        if not kept_segments:
            raise ValueError("没有保留的时间段")

        # 排序并合并相邻段
        merged_segments = self._merge_segments(kept_segments)

        output_path = self.output_dir / output_filename

        # 创建临时目录
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)

            # 提取每个保留段
            segment_files = []
            for i, (start_ms, end_ms) in enumerate(merged_segments):
                segment_file = temp_path / f"seg_{i}.mp4"
                self._extract_segment(input_path, start_ms, end_ms, segment_file)
                segment_files.append(segment_file)

            # 创建 concat 列表
            concat_list = temp_path / "concat_list.txt"
            with open(concat_list, "w") as f:
                for seg_file in segment_files:
                    f.write(f"file '{seg_file}'\n")

            # 合并视频
            self._concat_segments(concat_list, output_path)

        return str(output_path)

    def _merge_segments(
        self, segments: List[Tuple[int, int]]
    ) -> List[Tuple[int, int]]:
        """
        合并相邻的时间段

        例如：[(0, 1000), (1005, 2000)] -> [(0, 2000)]
        """
        if not segments:
            return []

        # 按起始时间排序
        sorted_segments = sorted(segments, key=lambda x: x[0])

        merged = [sorted_segments[0]]

        for current in sorted_segments[1:]:
            last = merged[-1]
            # 如果当前段的起始时间 <= 上一段的结束时间（考虑 100ms 容差），则合并
            if current[0] <= last[1] + 100:
                merged[-1] = (last[0], max(last[1], current[1]))
            else:
                merged.append(current)

        return merged

    def _extract_segment(
        self, input_path: str, start_ms: int, end_ms: int, output_path: Path
    ):
        """
        使用 ffmpeg 提取视频片段

        注意：-ss 必须放在 -i 之后（output seeking），确保帧精确裁剪。
        放在 -i 之前（input seeking）虽然快但会跳到最近关键帧，
        对短片段可能导致 0 个视频帧被提取（只剩音频）。

        Args:
            input_path: 输入视频
            start_ms: 起始时间（毫秒）
            end_ms: 结束时间（毫秒）
            output_path: 输出路径
        """
        start_sec = start_ms / 1000
        duration_sec = (end_ms - start_ms) / 1000

        cmd = [
            "ffmpeg",
            "-y",
            "-i", input_path,
            "-ss", str(start_sec),       # 放在 -i 之后：帧精确裁剪
            "-t", str(duration_sec),
            "-c:v", "libx264",
            "-c:a", "aac",
            "-avoid_negative_ts", "make_zero",
            "-map", "0:v:0",             # 显式映射视频流
            "-map", "0:a:0?",            # 显式映射音频流（可选）
            str(output_path),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"视频片段提取失败: {result.stderr}")

    def _concat_segments(self, concat_list: Path, output_path: Path):
        """
        使用 ffmpeg concat demuxer 合并视频片段

        所有片段已在 _extract_segment 中编码为 h264/aac，
        此处使用 stream copy 避免二次编码（更快、无质量损失）。
        """
        cmd = [
            "ffmpeg",
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list),
            "-c", "copy",
            "-movflags", "+faststart",
            str(output_path),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"视频合并失败: {result.stderr}")

    def burn_subtitles(
        self,
        input_video: str,
        subtitle_path: str,
        output_filename: str,
    ) -> str:
        """
        烧录字幕到视频

        样式与前端预览 CSS 完全一致：
        - 白色文字 + 半透明黑色背景框 rgba(0,0,0,0.7)
        - 无衬线字体，底部居中
        - 文字阴影增强可读性

        Args:
            input_video: 输入视频路径（已剪辑的视频）
            subtitle_path: SRT 字幕文件路径
            output_filename: 输出文件名

        Returns:
            输出视频路径
        """
        output_path = self.output_dir / output_filename

        # 使用 ffmpeg-full（支持 libass）
        ffmpeg_path = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"

        # ASS force_style - 与前端 .subtitle-overlay CSS 完全对齐
        # 无背景框，纯白色文字 + 黑色描边增强可读性
        # BorderStyle=1: 描边+阴影模式（无背景框）
        # Outline=1.5: 黑色描边宽度（模拟 CSS text-shadow 四方向描边）
        # Shadow=0: 无额外阴影
        force_style = (
            "FontName=PingFang SC,"
            "FontSize=18,"
            "PrimaryColour=&H00FFFFFF,"
            "OutlineColour=&H00000000,"
            "BackColour=&H00000000,"
            "BorderStyle=1,"
            "Outline=1.5,"
            "Shadow=0,"
            "MarginV=20,"
            "Alignment=2,"
            "Bold=0"
        )

        escaped_path = self._escape_subtitle_path(subtitle_path)
        vf = f"subtitles='{escaped_path}':force_style='{force_style}'"

        cmd = [
            ffmpeg_path,
            "-y",
            "-i", input_video,
            "-vf", vf,
            "-c:v", "libx264",
            "-c:a", "aac",
            str(output_path),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"字幕烧录失败: {result.stderr}")

        return str(output_path)

    @staticmethod
    def _escape_subtitle_path(path: str) -> str:
        """转义 ffmpeg subtitles 滤镜中的特殊字符"""
        path = path.replace("\\", "\\\\")
        path = path.replace(":", "\\:")
        path = path.replace("'", "\\'")
        path = path.replace("[", "\\[")
        path = path.replace("]", "\\]")
        return path

    def get_duration(self, video_path: str) -> float:
        """获取视频时长（秒）"""
        cmd = [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"获取视频时长失败: {result.stderr}")

        return float(result.stdout.strip())


def cut_video_by_deleted_words(
    input_path: str,
    sentences: List[dict],
    output_dir: str = "outputs",
) -> str:
    """
    根据删除的词计算保留段并剪辑视频

    Args:
        input_path: 输入视频路径
        sentences: ASR 转写结果（包含 words 列表）
        output_dir: 输出目录

    Returns:
        输出视频路径
    """
    # 收集所有保留的词时间段
    kept_segments = []

    for sentence in sentences:
        for word in sentence.get("words", []):
            if not word.get("deleted", False):
                # 保留这个词
                kept_segments.append((word["begin_time"], word["end_time"]))

    if not kept_segments:
        raise ValueError("所有词都被删除，没有保留内容")

    # 使用 VideoCutter 剪辑
    cutter = VideoCutter(output_dir)
    output_filename = f"cut_{Path(input_path).stem}.mp4"

    return cutter.cut_video(input_path, kept_segments, output_filename)
