"""
DetoxWeb — FastAPI Backend v2
Loads the trained Keras model and exposes a /predict endpoint
for the Chrome/Firefox Extension to call locally.

v2 additions:
- Server-side LRU sentence cache (OrderedDict, max 10 000 entries).
- Within-batch deduplication: identical sentences classified once per request.
"""

import os
import logging
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import List

import numpy as np
import tensorflow as tf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)s]  %(message)s",
)
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────
MODEL_PATH         = os.path.join(os.path.dirname(__file__), "toxic_comment_model.keras")
TOXICITY_THRESHOLD = 0.5
MAX_BATCH_SIZE     = 256    # hard cap per request
LRU_CACHE_SIZE     = 10_000 # sentences kept in memory


# ──────────────────────────────────────────────
# Simple LRU Cache (no external dependency)
# ──────────────────────────────────────────────
class LRUCache:
    """Thread-unsafe LRU cache backed by OrderedDict.
    Safe for single-worker uvicorn (no concurrent mutation)."""

    def __init__(self, max_size: int):
        self._cache: OrderedDict[str, float] = OrderedDict()
        self._max   = max_size

    def get(self, key: str) -> float | None:
        if key not in self._cache:
            return None
        self._cache.move_to_end(key)
        return self._cache[key]

    def put(self, key: str, value: float) -> None:
        if key in self._cache:
            self._cache.move_to_end(key)
        self._cache[key] = value
        if len(self._cache) > self._max:
            self._cache.popitem(last=False)  # evict LRU entry

    def __len__(self) -> int:
        return len(self._cache)


# ──────────────────────────────────────────────
# Global handles
# ──────────────────────────────────────────────
model: tf.keras.Model | None = None
sentence_cache = LRUCache(LRU_CACHE_SIZE)


# ──────────────────────────────────────────────
# Model Loader
# ──────────────────────────────────────────────
def load_model() -> tf.keras.Model:
    logger.info("Loading model from: %s", MODEL_PATH)
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(
            f"Model file not found at '{MODEL_PATH}'. "
            "Ensure toxic_comment_model.keras is in the same directory as app.py."
        )

    # ──────────────────────────────────────────────
    # Keras 3 Serialization Bug Workaround
    # Colab saved 'quantization_config' which Dense.__init__ rejects in HF's env.
    # ──────────────────────────────────────────────
    original_dense_init = tf.keras.layers.Dense.__init__
    def patched_dense_init(self, *args, **kwargs):
        kwargs.pop("quantization_config", None)
        original_dense_init(self, *args, **kwargs)
    tf.keras.layers.Dense.__init__ = patched_dense_init

    loaded = tf.keras.models.load_model(
        MODEL_PATH,
        custom_objects=None,
    )
    logger.info("Model loaded. Input shape: %s", loaded.input_shape)
    return loaded


# ──────────────────────────────────────────────
# Lifespan
# ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    model = load_model()
    yield
    logger.info("Shutting down DetoxWeb server.")


# ──────────────────────────────────────────────
# FastAPI App
# ──────────────────────────────────────────────
app = FastAPI(
    title="DetoxWeb API",
    description="Binary toxic-comment classifier backed by a Keras + TextVectorization model.",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────
class PredictRequest(BaseModel):
    sentences: List[str]

class SentenceResult(BaseModel):
    sentence:    str
    probability: float
    is_toxic:    bool

class PredictResponse(BaseModel):
    results:     List[SentenceResult]
    cache_hits:  int   # informational — how many were served from cache
    inferred:    int   # how many actually went through the model


# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────
@app.get("/health")
def health_check():
    return {
        "status":       "ok",
        "model_loaded": model is not None,
        "cache_size":   len(sentence_cache),
    }


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet.")

    sentences = request.sentences
    if not sentences:
        raise HTTPException(status_code=400, detail="'sentences' list must not be empty.")

    # Hard cap to protect the server
    if len(sentences) > MAX_BATCH_SIZE:
        logger.warning("Request truncated from %d to %d sentences.", len(sentences), MAX_BATCH_SIZE)
        sentences = sentences[:MAX_BATCH_SIZE]

    # ── Step 1: Check cache for each sentence ──────────────────────────────
    cache_hits   = 0
    to_infer: list[str] = []
    prob_map: dict[str, float] = {}

    for sent in sentences:
        cached_prob = sentence_cache.get(sent)
        if cached_prob is not None:
            prob_map[sent] = cached_prob
            cache_hits += 1
        elif sent not in prob_map:
            # Deduplicate within this request too
            to_infer.append(sent)

    # ── Step 2: Run model only on uncached + deduplicated sentences ────────
    if to_infer:
        input_tensor = tf.constant(to_infer, dtype=tf.string)
        raw_probs: np.ndarray = model.predict(input_tensor, batch_size=64, verbose=0)
        probs = raw_probs.flatten().tolist()

        for sent, prob in zip(to_infer, probs):
            rounded = round(prob, 4)
            prob_map[sent] = rounded
            sentence_cache.put(sent, rounded)  # persist to LRU cache

    # ── Step 3: Build ordered response ────────────────────────────────────
    results = [
        SentenceResult(
            sentence    = sent,
            probability = prob_map[sent],
            is_toxic    = prob_map[sent] >= TOXICITY_THRESHOLD,
        )
        for sent in sentences
    ]

    toxic_count = sum(1 for r in results if r.is_toxic)
    logger.info(
        "Batch: %d total | %d cache hits | %d inferred | %d toxic",
        len(sentences), cache_hits, len(to_infer), toxic_count,
    )

    return PredictResponse(
        results    = results,
        cache_hits = cache_hits,
        inferred   = len(to_infer),
    )
