#!/usr/bin/env python3
"""
转写示例

Usage:
    # 设置环境变量
    export DASHSCOPE_API_KEY='your-api-key'

    # 转写文件
    python examples/transcribe_example.py audio.wav

    # 或直接运行
    python -m src.transcriber audio.wav
"""

import sys
import os

# 添加项目根目录到 path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.transcriber import FunASRTranscriber, ModelType


def main():
    if len(sys.argv) < 2:
        print("用法: python transcribe_example.py <音频文件路径>")
        print("示例: python transcribe_example.py audio.wav")
        sys.exit(1)

    audio_file = sys.argv[1]

    # 从环境变量读取 API Key
    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        print("错误: 请设置 DASHSCOPE_API_KEY 环境变量")
        print("export DASHSCOPE_API_KEY='your-api-key'")
        sys.exit(1)

    print(f"开始转写文件: {audio_file}")
    print("-" * 50)

    try:
        transcriber = FunASRTranscriber(api_key=api_key)
        result = transcriber.transcribe(
            audio_file,
            model=ModelType.FUN_ASR,
            language="zh"
        )

        print(f"转写完成!")
        print(f"Task ID: {result.task_id}")
        print("-" * 50)
        print("转写结果:")
        print(result.text)

    except Exception as e:
        print(f"转写失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
