"""热词管理器"""
import json
import os
from typing import Dict, Optional
import dashscope
from dashscope.audio.asr import AsrPhraseManager, VocabularyService


# v2 模型使用 VocabularyService + vocabulary_id
V2_MODELS = {"paraformer-v2", "paraformer-8k-v2"}


class HotwordManager:
    """热词管理器，用于创建、删除热词

    使用流程:
    1. 创建热词: create_phrases(phrase_dict, model) -> hotword_id
    2. 转写时传入 phrase_id (v1) 或 vocabulary_id (v2)
    3. (可选) 删除热词: delete_phrases(hotword_id)
    """

    @staticmethod
    def create_phrases(phrase_dict: Dict[str, int], model: str = "paraformer-v2", api_key: Optional[str] = None) -> str:
        """
        创建热词

        Args:
            phrase_dict: 热词字典，格式如 {"word1": 权重, "word2": 权重}
                        权重范围 [1,5] 增强, [-6,-1] 减弱
            model: 模型名称，默认 paraformer-v2（推荐）
            api_key: API Key，不传则从环境变量读取

        Returns:
            hotword_id: 热词ID，用于后续转写调用
                      v1 模型返回 phrase_id，v2 模型返回 vocabulary_id
        """
        # 设置 API Key
        if api_key:
            dashscope.api_key = api_key
        elif not dashscope.api_key:
            dashscope.api_key = os.getenv("DASHSCOPE_API_KEY")

        # v2 模型使用 VocabularyService
        if model in V2_MODELS:
            service = VocabularyService()
            vocabulary = [
                {"text": word, "weight": weight}
                for word, weight in phrase_dict.items()
            ]
            # prefix 是热词表前缀，用于标识（最长10字符，仅英文数字）
            prefix = f"hw{model.replace('-', '')}"[:10]
            vocabulary_id = service.create_vocabulary(
                prefix=prefix,
                target_model=model,
                vocabulary=vocabulary
            )
            return vocabulary_id

        # v1 模型使用 AsrPhraseManager（直接传字典，不需要转list）
        resp = AsrPhraseManager.create_phrases(
            phrases=phrase_dict,  # 直接传字典，如 {'word': weight}
            model=model
        )

        if resp.status_code != 200:
            raise RuntimeError(f"热词创建失败: {resp.code} {resp.message}")

        # v1 返回 finetuned_output
        return resp.output.finetuned_output

    @staticmethod
    def delete_phrases(hotword_id: str) -> bool:
        """删除热词"""
        # v2 用 VocabularyService 删除，v1 用 AsrPhraseManager
        # 这里简化处理，统一尝试 VocabularyService
        try:
            service = VocabularyService()
            service.delete_vocabulary(vocabulary_id=hotword_id)
            return True
        except Exception:
            try:
                AsrPhraseManager.delete_phrases(phrase_id=hotword_id)
                return True
            except Exception:
                return False

    @staticmethod
    def load_from_file(file_path: str) -> Dict[str, int]:
        """从 JSON 文件加载热词配置"""
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
