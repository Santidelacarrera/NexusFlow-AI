"""Conjunto de datos de referencia definido y reproducible para evaluar la segmentación/abandono.

Proceso generativo (documentado en docs/ML_EVALUATION.md). Es SINTÉTICO: sirve para comparar modelos
y detectar regresiones, no para estimar el rendimiento sobre datos comerciales reales.
"""
import hashlib
import json
from datetime import datetime, timedelta, timezone

import numpy as np

BENCHMARK_AS_OF = datetime(2026, 10, 1, tzinfo=timezone.utc)
DEFAULT_SEED = 20261001
SPEC = {
    "customers": 900,
    "historyDays": 540,
    "purchaseRatePerDay": "lognormal(median=1/35, sigma=0.7)",
    "amount": "lognormal(median=60, sigma=0.6) por cliente, ruido lognormal(sigma=0.4) por compra",
    "lapseProbability": 0.4,
    "lapseTime": "uniforme entre 60 días tras el alta y 20 días antes del corte final",
    "label": "sin compra en los 90 días previos a asOf (ver features.py)",
}


def make_churn_benchmark(seed: int = DEFAULT_SEED, customers: int = SPEC["customers"]):
    rng = np.random.default_rng(seed)
    end = BENCHMARK_AS_OF
    start = end - timedelta(days=SPEC["historyDays"])
    rows = []
    for i in range(customers):
        joined = rng.uniform(0, SPEC["historyDays"] - 200)
        rate = float(rng.lognormal(np.log(1 / 35), 0.7))
        scale = float(rng.lognormal(np.log(60), 0.6))
        stop = float(SPEC["historyDays"])
        if rng.random() < SPEC["lapseProbability"]:
            stop = float(rng.uniform(joined + 60, SPEC["historyDays"] - 20))
        t = joined + float(rng.exponential(1 / rate))
        while t < stop:
            amount = round(float(scale * rng.lognormal(0, 0.4)), 2)
            rows.append({"customerId": f"c{i:04d}", "amount": max(amount, 0.01), "occurredAt": (start + timedelta(days=t)).isoformat()})
            t += float(rng.exponential(1 / rate))
    return rows, end.isoformat()


def dataset_fingerprint(transactions: list[dict]) -> str:
    canonical = json.dumps(transactions, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()
