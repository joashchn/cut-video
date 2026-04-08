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
# 基本用法（默认 paraformer-v2）
python cli.py audio.wav -o result.txt

# 输出带时间戳的结果
python cli.py audio.wav -t -o result.txt

# 使用热词（v1 或 v2 模型）
python cli.py audio.wav -w hotwords.json -t -o result.txt

# 使用 v1 模型
python cli.py audio.wav -m paraformer-v1 -w hotwords.json -t -o result.txt

# 使用 v2 模型
python cli.py audio.wav -m paraformer-v2 -w hotwords.json -t -o result.txt
```

### CLI 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `audio_file` | 音频文件路径 | - |
| `-o, --output` | 输出文件路径 | stdout |
| `-t, --timestamp` | 输出带时间戳的结果 | 关闭 |
| `-m, --model` | 模型类型 | paraformer-v2 |
| `-w, --hotword-file` | 热词配置文件路径（JSON） | - |
| `-l, --language` | 语言提示 | - |
| `-k, --api-key` | API Key | DASHSCOPE_API_KEY 环境变量 |

### 支持的模型

| 模型 | 说明 | 推荐场景 |
|------|------|---------|
| **paraformer-v2** | ✅ 默认，多语种支持更好 | 直播、会议等多语种 |
| paraformer-v1 | 中文效果好，热词支持 | 访谈、讲座等中英文混合 |

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
| `sentences` | List[dict] | 句子列表（含时间戳） |

### 时间戳格式

```
[00:00.03 -> 00:10.50] 所有只要处理data...
[00:11.45 -> 00:14.53] Again先对有一些也许对。
```

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

## 参考文档

- [阿里云百炼 FunASR 录音文件识别](https://help.aliyun.com/zh/model-studio/recording-file-recognition)
- [Paraformer 录音文件识别 API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-python-api)
- [Paraformer 热词定制与管理(v1)](https://help.aliyun.com/zh/model-studio/developer-reference/paraformer-asr-phrase-manager)
- [定制热词配置使用与API参考(v2)](https://help.aliyun.com/zh/model-studio/custom-hot-words/)
- [DashScope SDK](https://github.com/dashscope/dashscope-sdk-python)
