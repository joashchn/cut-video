"""
ASR 词级时间戳视频剪辑 Web 服务

FastAPI 应用入口
"""

import sys
from pathlib import Path
from dotenv import load_dotenv

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

# 加载 .env 文件
load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .router import video, cut

# 创建 FastAPI 应用
app = FastAPI(
    title="ASR 词级视频剪辑",
    description="基于阿里云百炼 FunASR API 的词级时间戳视频剪辑工具",
    version="1.0.0",
)

# 路径设置（基于 main.py 的位置）
BASE_DIR = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
UPLOADS_DIR = BASE_DIR / "uploads"
OUTPUTS_DIR = BASE_DIR / "outputs"

# 确保目录存在
UPLOADS_DIR.mkdir(exist_ok=True)
OUTPUTS_DIR.mkdir(exist_ok=True)

# 挂载静态文件目录
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

# 挂载 outputs 目录用于下载
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")

# 注册路由
app.include_router(video.router)
app.include_router(cut.router)


@app.get("/")
async def index():
    """返回前端页面"""
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/api/health")
async def health():
    """健康检查"""
    return {"status": "ok"}


# 启动时打印信息
@app.on_event("startup")
async def startup_event():
    print("=" * 50)
    print("ASR 词级视频剪辑服务已启动")
    print("访问 http://localhost:8000 使用 Web 界面")
    print("=" * 50)
