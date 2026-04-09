"""
文件定时清理服务

定时清理 uploads/ 和 outputs/ 目录中超过指定时间的文件，
同步清理内存中的 transcription_status 记录。
"""

import asyncio
import os
import time
from pathlib import Path
from typing import Optional


class FileCleanupService:
    """文件定时清理服务"""

    def __init__(
        self,
        dirs: list[Path],
        max_age_hours: float = 24,
        transcription_status: Optional[dict] = None,
    ):
        """
        Args:
            dirs: 需要清理的目录列表
            max_age_hours: 文件最大保留时间（小时），默认 24 小时
            transcription_status: 转写状态字典引用，用于同步清理内存记录
        """
        self.dirs = dirs
        self.max_age_seconds = max_age_hours * 3600
        self.transcription_status = transcription_status
        self._task: Optional[asyncio.Task] = None

    async def cleanup(self) -> int:
        """
        执行一次清理，删除超过 max_age 的文件

        Returns:
            删除的文件数量
        """
        now = time.time()
        deleted_count = 0
        cleaned_video_ids: set[str] = set()

        for directory in self.dirs:
            if not directory.exists():
                continue

            for file_path in directory.iterdir():
                if not file_path.is_file():
                    continue

                try:
                    mtime = file_path.stat().st_mtime
                    if (now - mtime) > self.max_age_seconds:
                        # 记录关联的 video_id
                        video_id = file_path.name.split("_")[0]
                        cleaned_video_ids.add(video_id)

                        file_path.unlink()
                        deleted_count += 1
                except Exception as e:
                    print(f"[清理] 删除文件失败 {file_path.name}: {e}")

        # 同步清理内存中的 transcription_status
        if self.transcription_status and cleaned_video_ids:
            for video_id in cleaned_video_ids:
                self.transcription_status.pop(video_id, None)

        if deleted_count:
            print(f"[清理] 已清理 {deleted_count} 个过期文件")

        return deleted_count

    async def start_scheduler(self, interval_hours: float = 1):
        """
        启动定时清理调度器

        Args:
            interval_hours: 清理间隔（小时），默认 1 小时
        """
        interval_seconds = interval_hours * 3600
        hours = self.max_age_seconds / 3600

        print(f"[清理] 定时清理已启用：每 {interval_hours} 小时检查一次，清理超过 {hours:.0f} 小时的文件")

        async def _loop():
            while True:
                await asyncio.sleep(interval_seconds)
                try:
                    await self.cleanup()
                except Exception as e:
                    print(f"[清理] 定时清理异常: {e}")

        self._task = asyncio.create_task(_loop())

    def stop(self):
        """停止定时清理"""
        if self._task:
            self._task.cancel()
            self._task = None
