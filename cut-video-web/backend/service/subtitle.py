"""
SRT 字幕生成服务

根据 ASR 转写结果生成 SRT 格式字幕文件
"""

from pathlib import Path
from typing import List, Tuple


class SubtitleGenerator:
    """SRT 字幕生成器"""

    def __init__(self, output_dir: str = "outputs"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)

    def generate_srt(
        self,
        sentences: List[dict],
        output_filename: str,
        kept_segments: List[Tuple[int, int]] = None,
    ) -> str:
        """
        根据保留的句子生成 SRT 字幕文件

        每个有标点符号的完整句子作为一条字幕

        Args:
            sentences: ASR 句子列表（包含 words）
            output_filename: 输出 srt 文件名
            kept_segments: 保留段时间列表，用于计算相对时间戳

        Returns:
            SRT 文件路径
        """
        srt_path = self.output_dir / output_filename

        subtitle_entries = self._build_sentence_subtitles(sentences, kept_segments)

        # 写入 SRT 文件
        self._write_srt(subtitle_entries, srt_path)

        return str(srt_path)

    def _build_sentence_subtitles(
        self,
        sentences: List[dict],
        kept_segments: List[Tuple[int, int]],
    ) -> List[Tuple[int, int, str]]:
        """
        根据句子构建字幕 - 按标点符号拆分，每个片段成为一条字幕

        Args:
            sentences: ASR 句子列表
            kept_segments: 保留段时间列表 [(orig_start, orig_end), ...]

        Returns:
            [(adjusted_start_ms, adjusted_end_ms, text), ...]
        """
        if not kept_segments:
            return []

        subtitles = []

        for sentence in sentences:
            words = sentence.get("words", [])
            if not words:
                continue

            # 获取保留的词
            kept_words = [w for w in words if not w.get("deleted", False)]
            if not kept_words:
                continue

            # 使用文本中标点位置来划分词
            segments = self._split_words_by_punctuation_positions(sentence["text"], words)

            for segment_words in segments:
                # 过滤保留的词（被删除的词不显示）
                segment_kept = [w for w in segment_words if not w.get("deleted", False)]
                if not segment_kept:
                    continue

                # 构建文本（只包含保留的词）
                text = "".join(word["text"] for word in segment_kept)

                # 使用保留词的时间戳
                orig_start = segment_kept[0]["begin_time"]
                orig_end = segment_kept[-1]["end_time"]

                # 映射到相对时间
                adjusted_start = self._map_original_to_adjusted(orig_start, kept_segments)
                adjusted_end = self._map_original_to_adjusted(orig_end, kept_segments)

                if adjusted_end > adjusted_start:
                    subtitles.append((adjusted_start, adjusted_end, text))

        return subtitles

    def _split_words_by_punctuation_positions(self, sentence_text: str, words: List[dict]) -> List[List[dict]]:
        """
        根据句子文本中标点符号的位置，将词列表拆分成多个片段

        逐词在句子文本中查找匹配位置来确定分割点

        Args:
            sentence_text: 完整句子文本（包含标点）
            words: 词的列表

        Returns:
            按标点拆分后的词列表
        """
        punctuations = '，。！？、；：""''（）'

        # 找出所有标点在句子文本中的位置
        punct_positions = set(i for i, c in enumerate(sentence_text) if c in punctuations)

        if not punct_positions:
            return [words]

        # 通过逐词匹配找到每个词在句子中的位置
        word_positions = []  # (start, end) in sentence_text
        search_start = 0
        for word in words:
            word_text = word["text"]
            # 在 sentence_text 中查找这个词
            idx = sentence_text.find(word_text, search_start)
            if idx >= 0:
                word_positions.append((idx, idx + len(word_text) - 1))
                search_start = idx + len(word_text)
            else:
                # 如果找不到，使用估算位置
                word_positions.append((-1, -1))

        # 确定分割点：在标点位置之后的词开始处
        split_indices = set()
        for p in punct_positions:
            for i, (start, end) in enumerate(word_positions):
                if start > p:
                    # 这个词的开始位置在标点之后，分割在上一个词之后
                    if i > 0:
                        split_indices.add(i - 1)
                    break
                elif start <= p <= end:
                    # 标点在这个词范围内，分割在当前词之后
                    split_indices.add(i)
                    break

        # 处理句尾标点（在所有词之后）
        if word_positions:
            last_end = word_positions[-1][1]
            if last_end >= 0:
                for p in punct_positions:
                    if p > last_end:
                        split_indices.add(len(words) - 1)
                        break

        # 使用 split_indices 来分割词列表
        segments = []
        current_segment = []
        for i, word in enumerate(words):
            current_segment.append(word)
            if i in split_indices:
                segments.append(current_segment)
                current_segment = []

        if current_segment:
            segments.append(current_segment)

        return segments

    def _map_original_to_adjusted(
        self,
        original_ms: int,
        kept_segments: List[Tuple[int, int]],
    ) -> int:
        """
        将原始视频的时间映射到剪辑后视频的相对时间

        原理：对于时间点 T 在 segment i 中
        adjusted = sum(segment_j.duration for j < i) + (T - segment_i.start)
        """
        cumulative_offset = 0

        for i, (start_ms, end_ms) in enumerate(kept_segments):
            if original_ms < start_ms:
                # 在当前保留段之前（gap 中）
                return cumulative_offset
            elif start_ms <= original_ms <= end_ms:
                # 在当前保留段内
                return cumulative_offset + (original_ms - start_ms)
            else:
                # 时间在当前保留段之后，累加这段的时长
                cumulative_offset += (end_ms - start_ms)

        # 超出所有保留段，返回总时长
        return cumulative_offset

    def _write_srt(self, entries: List[Tuple[int, int, str]], output_path: Path):
        """写入 SRT 文件"""
        with open(output_path, "w", encoding="utf-8") as f:
            for i, (start_ms, end_ms, text) in enumerate(entries, 1):
                start_srt = self._ms_to_srt_time(start_ms)
                end_srt = self._ms_to_srt_time(end_ms)
                f.write(f"{i}\n")
                f.write(f"{start_srt} --> {end_srt}\n")
                f.write(f"{text}\n\n")

    def _ms_to_srt_time(self, ms: int) -> str:
        """将毫秒转换为 SRT 时间格式 (HH:MM:SS,mmm)"""
        hours = ms // 3600000
        ms %= 3600000
        minutes = ms // 60000
        ms %= 60000
        seconds = ms // 1000
        millis = ms % 1000
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"
