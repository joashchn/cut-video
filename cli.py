#!/usr/bin/env python3
"""
ASR 转写命令行工具

Usage:
    # 转写音频
    python cli.py audio.wav -o result.txt

    # 转写视频（自动提取音频）
    python cli.py video.mp4 -o result.txt

    # 输出带时间戳的结果
    python cli.py video.mp4 -t -o result.txt

    # 指定视频提取的音频保存位置
    python cli.py video.mp4 --audio-output audio.wav -o result.txt
"""

import argparse
import os
import sys
from dotenv import load_dotenv

from src.transcriber import FunASRTranscriber, ModelType
from src.hotword import HotwordManager


def format_timestamp(seconds: float) -> str:
    """将秒数格式化为 mm:ss.ms"""
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes:02d}:{secs:05.2f}"


def main():
    # 加载 .env 文件
    load_dotenv()

    parser = argparse.ArgumentParser(description="ASR 音频转写工具")
    parser.add_argument("input_file", help="音频或视频文件路径")
    parser.add_argument(
        "--model",
        "-m",
        choices=["fun-asr", "paraformer-v1", "paraformer-v2", "sensevoice"],
        default="paraformer-v2",
        help="模型类型 (默认: paraformer-v2)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="输出文件路径 (默认: 打印到 stdout)",
    )
    parser.add_argument(
        "--timestamp",
        "-t",
        action="store_true",
        help="输出带时间戳的结果",
    )
    parser.add_argument(
        "--audio-output",
        "-a",
        help="视频提取音频时的保存路径 (默认: 同名 wav)",
    )
    parser.add_argument(
        "--language",
        "-l",
        help="语言提示，如 zh, en",
    )
    parser.add_argument(
        "--hotword-file",
        "-w",
        help="热词配置文件路径（JSON 格式），如 ./hotwords.json",
    )
    parser.add_argument(
        "--api-key",
        "-k",
        help="API Key (默认从 DASHSCOPE_API_KEY 环境变量读取)",
    )

    args = parser.parse_args()

    # 获取 API Key
    api_key = args.api_key or os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        print("错误: 请设置 DASHSCOPE_API_KEY 环境变量")
        print("export DASHSCOPE_API_KEY='your-api-key'")
        sys.exit(1)

    # 映射模型名称
    model_map = {
        "fun-asr": ModelType.FUN_ASR,
        "paraformer-v1": ModelType.PARAFORMER_V1,
        "paraformer-v2": ModelType.PARAFORMER_V2,
        "sensevoice": ModelType.SENSE_VOICE,
    }
    model = model_map[args.model]

    print(f"开始转写: {args.input_file}")
    print(f"使用模型: {args.model}")
    print(f"时间戳: {'开启' if args.timestamp else '关闭'}")
    print("-" * 50)

    # 处理热词
    phrase_id = None
    vocabulary_id = None
    if args.hotword_file:
        print(f"加载热词配置: {args.hotword_file}")
        phrases = HotwordManager.load_from_file(args.hotword_file)
        hotword_id = HotwordManager.create_phrases(phrases, model=args.model, api_key=api_key)
        # v2 模型使用 vocabulary_id，v1 使用 phrase_id
        if args.model == "paraformer-v2":
            vocabulary_id = hotword_id
            print(f"热词已创建，vocabulary_id: {vocabulary_id}")
        else:
            phrase_id = hotword_id
            print(f"热词已创建，phrase_id: {phrase_id}")
        print(f"热词数量: {len(phrases)}")

    try:
        transcriber = FunASRTranscriber(api_key=api_key)
        result = transcriber.transcribe(
            args.input_file,
            model=model,
            language=args.language,
            output_audio_path=args.audio_output,
            phrase_id=phrase_id,
            vocabulary_id=vocabulary_id,
        )

        print(f"转写完成! Task ID: {result.task_id}")
        print(f"音频时长: {result.duration_seconds:.1f} 秒")
        print("-" * 50)

        if args.timestamp and result.sentences:
            # 输出带时间戳的结果（含词级）
            output_lines = []
            for s in result.sentences:
                begin = format_timestamp(s["begin_time"] / 1000)
                end = format_timestamp(s["end_time"] / 1000)
                line = f"[{begin} -> {end}] {s['text']}"
                output_lines.append(line)
                # 添加词级时间戳
                if s.get("words"):
                    for w in s["words"]:
                        w_begin = w["begin_time"]
                        w_end = w["end_time"]
                        w_line = f"    [{w_begin}ms -> {w_end}ms] {w['text']}"
                        output_lines.append(w_line)

            output_text = "\n".join(output_lines)
        else:
            output_text = result.text

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output_text)
            print(f"结果已保存到: {args.output}")
        else:
            print("转写结果:")
            print(output_text)

    except Exception as e:
        print(f"错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
