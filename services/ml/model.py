import hashlib
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np
import pandas as pd
import shap
from sklearn.dummy import DummyClassifier
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier

from features import FEATURES, build_training_rows
from metrics import classification_metrics

MODEL_ROOT = Path(os.environ.get("MODEL_DIR", "models"))
TRAIN_LOCK = threading.Lock()


def org_dir(org_id: str) -> Path:
    return MODEL_ROOT / hashlib.sha256(org_id.encode()).hexdigest()


PRODUCT_METRICS = ("precision", "recall", "f1", "prAuc")


def metrics(y, probabilities):
    """Métricas que se muestran al usuario. El cálculo vive en metrics.py (compartido con evaluation.py)."""
    full = classification_metrics(y, probabilities)
    return {k: full[k] for k in PRODUCT_METRICS}


def build_model(seed: int = 42, n_jobs: int = 2) -> XGBClassifier:
    """Hiperparámetros del modelo de producción; evaluation.py evalúa exactamente esta configuración."""
    return XGBClassifier(n_estimators=80, max_depth=3, learning_rate=0.06, n_jobs=n_jobs, random_state=seed, eval_metric="logloss", reg_lambda=3)


def heuristic_probability(recency_days):
    """Indicador orientativo sin entrenamiento (también usado como línea base en la evaluación)."""
    return np.clip(1 / (1 + np.exp(-(np.asarray(recency_days, dtype=float) - 75) / 25)), 0.01, 0.99)


def train(org_id: str, transactions: list[dict], as_of: str):
    if not TRAIN_LOCK.acquire(blocking=False):
        raise ValueError("Ya hay un entrenamiento en curso")
    try:
        rows, cutoff = build_training_rows(transactions, as_of)
        counts = rows.churn.value_counts()
        if len(rows) < 80 or len(counts) < 2 or counts.min() < 20:
            raise ValueError("Se requieren 80 clientes y al menos 20 ejemplos por clase")
        train_rows, test_rows = train_test_split(rows, test_size=0.25, random_state=42, stratify=rows.churn)
        x_train, y_train = train_rows[FEATURES], train_rows.churn
        x_test, y_test = test_rows[FEATURES], test_rows.churn
        model = build_model()
        model.fit(x_train, y_train)
        evaluation = metrics(y_test, model.predict_proba(x_test)[:, 1])
        baseline = DummyClassifier(strategy="prior").fit(x_train, y_train)
        base_metrics = metrics(y_test, baseline.predict_proba(x_test)[:, 1])
        # Línea base más exigente (informativa): ordenar solo por días sin comprar. Ver docs/ML_EVALUATION.md.
        recency_metrics = metrics(y_test, heuristic_probability(x_test["recencyDays"].to_numpy()))
        report = {**evaluation, "baseline": base_metrics, "trainCustomers": len(train_rows), "testCustomers": len(test_rows), "cutoff": cutoff, "asOf": as_of, "horizonDays": 90, "labelDefinition": "sin compra durante los 90 días posteriores al corte", "validation": "clientes disjuntos, corte histórico y ventana futura observada", "beatsBaseline": evaluation["prAuc"] > base_metrics["prAuc"], "recencyBaseline": recency_metrics, "beatsRecencyBaseline": evaluation["prAuc"] > recency_metrics["prAuc"], "trainedAt": datetime.now(timezone.utc).isoformat(), "features": FEATURES}
        if not report["beatsBaseline"]:
            return {"promoted": False, "metrics": report}
        version = f"xgb-{uuid4().hex}"
        directory = org_dir(org_id)
        directory.mkdir(parents=True, exist_ok=True)
        model.save_model(directory / f"{version}.json")
        # El manifiesto se sustituye de forma atómica; nunca se deserializa pickle externo.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=directory, delete=False) as tmp:
            json.dump({"version": version, "metrics": report}, tmp)
            temp_name = tmp.name
        os.replace(temp_name, directory / "manifest.json")
        return {"promoted": True, "version": version, "metrics": report}
    finally:
        TRAIN_LOCK.release()


def score(org_id: str, customers: list[dict]):
    x = pd.DataFrame(customers)
    manifest_path = org_dir(org_id) / "manifest.json"
    if not manifest_path.exists():
        # Indicador transparente, no se presenta como un modelo entrenado ni se automatiza.
        probability = heuristic_probability(x.recencyDays.to_numpy())
        return {"version": "heuristic-recency-v1", "mode": "heuristic", "metrics": {"warning": "Sin modelo entrenado. Indicador orientativo de recencia; no es una probabilidad calibrada."}, "predictions": [{"customerId": c["customerId"], "probability": float(p), "explanation": {"method": "heuristic", "recencyDays": c["recencyDays"], "note": "Mayor tiempo sin compra aumenta el indicador. Sin inferencia causal."}} for c, p in zip(customers, probability)]}
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    model = XGBClassifier()
    model.load_model(org_dir(org_id) / f"{manifest['version']}.json")
    probabilities = model.predict_proba(x[FEATURES])[:, 1]
    contributions = shap.TreeExplainer(model)(x[FEATURES])
    predictions = []
    for i, c in enumerate(customers):
        predictions.append({"customerId": c["customerId"], "probability": float(probabilities[i]), "explanation": {"method": "SHAP", "units": "log-odds", "baseValue": float(contributions.base_values[i]), "features": [{"name": f, "value": float(x.iloc[i][f]), "contribution": float(contributions.values[i][j])} for j, f in enumerate(FEATURES)], "note": "Contribuciones al modelo, no causalidad. Validar calibración y drift con datos propios."}})
    return {**manifest, "mode": "trained", "predictions": predictions}
