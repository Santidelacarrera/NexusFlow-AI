"""Métricas de evaluación. Sin dependencias del producto: solo (y, probabilidades) → números."""
import numpy as np
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)


def classification_metrics(y, probabilities, threshold: float = 0.5) -> dict:
    y = np.asarray(y)
    probabilities = np.asarray(probabilities, dtype=float)
    predicted = probabilities >= threshold
    tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel()
    both = len(np.unique(y)) == 2
    return {
        "precision": float(precision_score(y, predicted, zero_division=0)),
        "recall": float(recall_score(y, predicted, zero_division=0)),
        "f1": float(f1_score(y, predicted, zero_division=0)),
        "prAuc": float(average_precision_score(y, probabilities)),
        "rocAuc": float(roc_auc_score(y, probabilities)) if both else float("nan"),
        "brier": float(brier_score_loss(y, probabilities)),
        "confusion": {"tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn)},
    }


def top_decile_lift(y, probabilities) -> float:
    """Tasa de abandono en el 10 % de mayor riesgo dividida por la tasa global."""
    y = np.asarray(y)
    order = np.argsort(-np.asarray(probabilities), kind="stable")
    k = max(1, len(y) // 10)
    base = y.mean()
    return float(y[order[:k]].mean() / base) if base > 0 else float("nan")


def calibration_bins(y, probabilities, bins: int = 10) -> list[dict]:
    y = np.asarray(y)
    p = np.asarray(probabilities, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    index = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    out = []
    for b in range(bins):
        mask = index == b
        if mask.any():
            out.append({"bin": f"{edges[b]:.1f}-{edges[b + 1]:.1f}", "n": int(mask.sum()), "meanPredicted": float(p[mask].mean()), "observedRate": float(y[mask].mean())})
    return out


def paired_bootstrap_diff(y, p_model, p_base, metric, n: int = 400, seed: int = 0) -> dict:
    """IC 95 % de metric(model) - metric(base) remuestreando clientes (mismos índices para ambos)."""
    y, a, b = np.asarray(y), np.asarray(p_model), np.asarray(p_base)
    rng = np.random.default_rng(seed)
    diffs = []
    for _ in range(n):
        idx = rng.integers(0, len(y), len(y))
        if len(np.unique(y[idx])) < 2:
            continue
        diffs.append(metric(y[idx], a[idx]) - metric(y[idx], b[idx]))
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return {"meanDiff": float(np.mean(diffs)), "ci95": [float(lo), float(hi)], "excludesZero": bool(lo > 0 or hi < 0), "resamples": len(diffs)}


def summarize(values) -> dict:
    v = np.asarray(values, dtype=float)
    return {"mean": float(v.mean()), "std": float(v.std(ddof=1)) if len(v) > 1 else 0.0, "min": float(v.min()), "max": float(v.max()), "n": int(len(v))}
