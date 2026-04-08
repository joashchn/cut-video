# cut-video-asr

ASR 语音识别工具，基于阿里云百炼 FunASR API。

## 功能

- 长音频转写（最长 12 小时，2GB 文件）
- 支持中文、英文等多语言（含方言）
- 本地文件直传（无需自备 OSS，百炼提供临时存储）
- **时间戳输出**（毫秒级）
- **语气词过滤**
- **视频文件支持**（自动用 ffmpeg 提取音频）
- **热词支持**（v1 和 v2 模型）
- 命令行工具 + Python API

## 环境准备

1. **获取阿里云百炼 API Key**
   - 登录 https://bailian.console.aliyun.com/
   - 创建 API Key

2. **设置环境变量**
   ```bash
   export DASHSCOPE_API_KEY='your-api-key'
   ```
   或在项目根目录创建 `.env` 文件：
   ```
   DASHSCOPE_API_KEY=your-api-key
   ```

## 安装

```bash
uv sync
```

## 使用

### 命令行

```bash
# 基本用法（默认 paraformer-v1 + 热词）
python cli.py audio.wav -o result.txt

# 输出带时间戳的结果
python cli.py audio.wav -t -o result.txt

# 使用 v2 模型
python cli.py audio.wav -m paraformer-v2 -t -o result.txt

# 使用 v1 模型 + 自定义热词
python cli.py audio.wav -m paraformer-v1 -w hotwords.json -t -o result.txt

# 使用 v2 模型 + 热词
python cli.py audio.wav -m paraformer-v2 -w hotwords.json -t -o result.txt
```

### CLI 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `audio_file` | 音频文件路径 | - |
| `-o, --output` | 输出文件路径 | stdout |
| `-t, --timestamp` | 输出带时间戳的结果 | 关闭 |
| `-m, --model` | 模型类型 | paraformer-v1 |
| `-w, --hotword-file` | 热词配置文件路径（JSON） | - |
| `-l, --language` | 语言提示 | - |
| `-k, --api-key` | API Key | DASHSCOPE_API_KEY 环境变量 |

### 支持的模型

| 模型 | 说明 | 推荐场景 |
|------|------|---------|
| **paraformer-v1** | ✅ 默认，中文效果好，热词支持更好 | 访谈、讲座等中英文混合 |
| paraformer-v2 | 多语种支持更好 | 直播、会议等多语种 |

### 热词功能

**热词配置 `hotwords.json`**:
```json
{
  "colleague": 3,
  "skill": 2,
  "反蒸馏": 4,
  "数字生命": 5,
  "HTTP": 2,
  "运维": 5,
  "网安": 5,
  "distill": 2,
  "anti": 2,
  "AI": 2,
  "赛博永生": 4,
  "Paraformer": 2,
  "热词": 2,
  "缓存": 2
}
```

**热词限制**:
- 最多 500 个热词
- 中文热词 ≤10 字符
- 英文/混合热词 ≤5 词
- 权重范围: [1,5] 增强, [-6,-1] 减弱

### Python API

```python
from src.transcriber import FunASRTranscriber, ModelType

transcriber = FunASRTranscriber()

# 基本转写（v2 模型）
result = transcriber.transcribe(
    audio_file_path="audio.wav",
    model=ModelType.PARAFORMER_V2,
)
print(result.text)

# v2 模型热词
result = transcriber.transcribe(
    audio_file_path="audio.wav",
    model=ModelType.PARAFORMER_V2,
    vocabulary_id="your_vocabulary_id",
)

# v1 模型热词
result = transcriber.transcribe(
    audio_file_path="audio.wav",
    model=ModelType.PARAFORMER_V1,
    phrase_id="your_phrase_id",
)
```

### TranscriptionResult 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `text` | str | 转写文本 |
| `task_id` | str | 任务 ID |
| `task_status` | str | 任务状态 |
| `duration_seconds` | float | 音频时长（秒） |
| `sentences` | List[dict] | 句子列表（含时间戳和词级时间戳） |

### 时间戳格式

#### 句子级 + 词级时间戳

使用 `-t` 参数时，输出包含**词级时间戳**：

```
[00:04.42 -> 00:12.46] 这个世界已经有点癫了，最近这个colleague skill已经斩获了8.9K的star，将冰冷的离别化为温暖的skill。
    [4420ms -> 4970ms] 这个世界
    [4970ms -> 5180ms] 已经
    [5180ms -> 5520ms] 有点
    [5520ms -> 5760ms] 癫
    [5760ms -> 5820ms] 了
    [6210ms -> 6550ms] 最近
    ...
[00:12.46 -> 00:16.04] 欢迎加入数字生命1.0，实现了赛博永生。
    [12460ms -> 12910ms] 欢迎
    [12910ms -> 13270ms] 加入
    ...
```

#### 数据结构

`sentences` 字段包含句子级和词级时间戳：

```python
sentences = [
    {
        "text": "句子文本",
        "begin_time": 4420,   # 毫秒
        "end_time": 12460,    # 毫秒
        "words": [
            {"text": "这个世界", "begin_time": 4420, "end_time": 4970},
            {"text": "已经", "begin_time": 4970, "end_time": 5180},
            ...
        ]
    },
    ...
]
```

#### 应用场景

- **字幕可视化编辑**：点击任意词删除对应时间段
- **精确剪辑**：删除单个词（而非整句）

## 项目结构

```
.
├── pyproject.toml              # uv 项目配置
├── README.md                  # 项目说明
├── .env                       # 环境变量（API Key）
├── .env.example               # 环境变量示例
├── cli.py                     # 命令行工具
├── hotwords.json              # 热词配置
├── src/
│   ├── __init__.py
│   ├── transcriber.py         # FunASR API 封装
│   └── hotword.py             # 热词管理器
└── examples/
    └── transcribe_example.py  # 使用示例
```

## 热词功能说明

### 工作流程

```
本地 hotwords.json  →  创建热词 API  →  获取 ID  →  转写时引用
```

1. 读取本地 `hotwords.json` 配置
2. 调用百炼 API 创建热词，获取 `phrase_id` (v1) 或 `vocabulary_id` (v2)
3. 转写时传入对应 ID，服务端使用已存储的热词增强识别

### v1 vs v2 热词对比

| 模型 | 热词 API | 返回 ID | 参数 |
|------|----------|---------|------|
| paraformer-v1 | AsrPhraseManager | finetuned_output | phrase_id |
| paraformer-v2 | VocabularyService | vocabulary_id | vocabulary_id |

### 测试结果

使用热词后，部分词汇识别有明显改善：

| 词汇 | 无热词 | 有热词 | 热词配置 |
|------|--------|--------|----------|
| 愿维兄弟 → 运维兄弟 | ❌ | ✅ V1+V2 | `"运维": 5` |
| 反真流 → 反蒸馏 | ❌ | ✅ V1+V2 | `"反蒸馏": 4` |
| HTTB → HTTP | ❌ | ✅ V1 | `"HTTP": 2` |
| 广安 → 网安 | ❌ | ✅ V1 | `"网安": 5` |

**注意**: v1 和 v2 的热词是独立的，不能交叉使用。

## Web 界面（视频剪辑）

### 功能
- 上传视频，自动 ASR 转写（**默认 v1 + 热词 + 词级时间戳**）
- 词级时间戳显示，点击删除词组
- 根据删除的词组剪辑视频
- **字幕烧录**：可选择将字幕烧录到导出视频中

### 启动

```bash
# 安装依赖
cd cut-video-web
uv sync

# 启动服务（需要设置 DASHSCOPE_API_KEY）
export DASHSCOPE_API_KEY='your-api-key'
uvicorn backend.main:app --reload --port 8000
# 打开 http://localhost:8000
```

### 默认配置
- 模型：paraformer-v1（热词效果更好）
- 热词：使用项目内置 hotwords.json
- 时间戳：词级精度

### 使用流程
1. 打开 http://localhost:8000
2. 上传视频文件（拖拽或点击选择）
3. 等待 ASR 转写完成（自动使用 v1 + 热词）
4. 点击词标记删除（红色删除线）
5. 勾选"烧录字幕"可选项
6. 点击"执行剪辑"
7. 下载剪辑后的视频

### 字幕烧录功能

- **按标点分割**：根据句子中的标点符号（，。！？等）自动分割成多条字幕
- **智能过滤**：被删除的词不会出现在字幕中
- **时间戳对齐**：字幕时间与剪辑后的视频精确对应

### 项目结构

```
cut-video-web/
├── backend/
│   ├── main.py              # FastAPI 入口
│   ├── router/
│   │   ├── video.py         # 视频上传、转写 API
│   │   └── cut.py           # 视频剪辑 API
│   └── service/
│       ├── cutter.py        # ffmpeg 剪辑逻辑
│       └── subtitle.py     # SRT 字幕生成
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── uploads/                  # 视频存储
└── outputs/                  # 输出视频
```

---

## 参考文档

- [阿里云百炼 FunASR 录音文件识别](https://help.aliyun.com/zh/model-studio/recording-file-recognition)
- [Paraformer 录音文件识别 API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-python-api)
- [Paraformer 热词定制与管理(v1)](https://help.aliyun.com/zh/model-studio/developer-reference/paraformer-asr-phrase-manager)
- [定制热词配置使用与API参考(v2)](https://help.aliyun.com/zh/model-studio/custom-hot-words/)
- [DashScope SDK](https://github.com/dashscope/dashscope-sdk-python)
