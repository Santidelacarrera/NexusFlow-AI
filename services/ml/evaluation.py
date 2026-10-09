"""Evaluación reproducible del modelo de abandono frente a líneas base.

Separado de la lógica del producto: solo importa `build_model`/`heuristic_probability` (la configuración
exacta que se despliega) y no escribe nada en los modelos de las organizaciones.

    python evaluation.py --out reports/ml_evaluation.json [--markdown ../../docs/ML_EVALUATION_RESULTS.md]

Determinismo: semillas fijas, n_jobs=1 y datos sintéticos generados por `datasets.py`. El bloque `results`
no contiene tiempos ni versiones; su hash (`reproducibilityHash`) debe ser idéntico entre ejecuciones con las
mismas versiones de librerías. `performance` y `environment` quedan fuera del hash.
"""
import argparse
import hashlib
import json
import platform
import time
from pathlib import Path

import numpy as np
import pandas as pd
import shap
import sklearn
import xgboost
from scipy.stats import spearmanr
from sklearn.dummy import DummyClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from datasets import DEFAULT_SEED, SPEC, dataset_fingerprint, make_churn_benchmark
from features import FEATURES, build_training_rows
from metrics import calibration_bins, classification_metrics, paired_bootstrap_diff, summarize, top_decile_lift
from model import build_model, heuristic_probability

MODELS = ("xgboost", "baseline_prior", "baseline_recency", "baseline_logreg")


def _fit_predict(name: str, x_train, y_train, x_test, seed: int):
    if name == "xgboost":
        return build_model(seed, n_jobs=1).fit(x_train, y_train).predict_proba(x_test)[:, 1]
    if name == "baseline_prior":
        return DummyClassifier(strategy="prior").fit(x_train, y_train).predict_proba(x_test)[:, 1]
    if name == "baseline_recency":
        # Sin entrenamiento: solo ordena por días sin comprar (la heurística que usa el producto sin modelo).
        return heuristic_probability(x_test["recencyDays"].to_numpy())
    if name == "baseline_logreg":
        pipe = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, random_state=seed))
        return pipe.fit(x_train, y_train).predict_proba(x_test)[:, 1]
    raise ValueError(name)


def _round(value, ndigits=6):
    if isinstance(value, dict):
        return {k: _round(v, ndigits) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round(v, ndigits) for v in value]
    if isinstance(value, (float, np.floating)):
        return None if np.isnan(value) else round(float(value), ndigits)
    if isinstance(value, np.integer):
        return int(value)
    return value


def cross_validate(rows: pd.DataFrame, seed: int, n_splits: int, n_repeats: int) -> dict:
    x, y = rows[FEATURES].reset_index(drop=True), rows.churn.reset_index(drop=True)
    splitter = RepeatedStratifiedKFold(n_splits=n_splits, n_repeats=n_repeats, random_state=seed)
    folds = {m: [] for m in MODELS}
    oof = {m: np.zeros((n_repeats, len(y))) for m in MODELS}
    for i, (train_idx, test_idx) in enumerate(splitter.split(x, y)):
        repeat = i // n_splits
        for m in MODELS:
            p = _fit_predict(m, x.iloc[train_idx], y.iloc[train_idx], x.iloc[test_idx], seed)
            folds[m].append(classification_metrics(y.iloc[test_idx], p))
            oof[m][repeat, test_idx] = p
    summary = {}
    for m in MODELS:
        summary[m] = {k: summarize([f[k] for f in folds[m]]) for k in ("prAuc", "rocAuc", "f1", "precision", "recall", "brier")}
    # Predicciones fuera de muestra promediadas entre repeticiones → errores, calibración y comparaciones pareadas.
    pooled = {m: oof[m].mean(axis=0) for m in MODELS}
    y_arr = y.to_numpy()
    comparisons = {
        f"xgboost_vs_{b}": paired_bootstrap_diff(y_arr, pooled["xgboost"], pooled[b], average_precision_score, seed=seed)
        for b in ("baseline_prior", "baseline_recency", "baseline_logreg")
    }
    errors = {m: classification_metrics(y_arr, pooled[m])["confusion"] for m in MODELS}
    return {
        "folds": f"{n_repeats}x{n_splits} estratificado por cliente",
        "summary": summary,
        "comparisons": comparisons,
        "errorsAtThreshold0.5": errors,
        "topDecileLift": {m: top_decile_lift(y_arr, pooled[m]) for m in MODELS},
        "calibrationXgboost": calibration_bins(y_arr, pooled["xgboost"]),
    }


def seed_stability(rows: pd.DataFrame, seeds=(1, 2, 3, 4, 5)) -> dict:
    """Mismo reparto de datos, distinta semilla del modelo: ¿cuánto cambia el resultado?"""
    from sklearn.model_selection import train_test_split

    train, test = train_test_split(rows, test_size=0.25, random_state=42, stratify=rows.churn)
    scores = []
    for s in seeds:
        p = _fit_predict("xgboost", train[FEATURES], train.churn, test[FEATURES], s)
        scores.append(classification_metrics(test.churn, p)["prAuc"])
    return {"seeds": list(seeds), "prAuc": summarize(scores)}


def dataset_stability(seeds, n_splits: int) -> dict:
    """Distintas muestras sintéticas: ¿el modelo supera a las líneas base de forma consistente?"""
    out = []
    for s in seeds:
        tx, as_of = make_churn_benchmark(seed=s)
        rows, _ = build_training_rows(tx, as_of)
        cv = cross_validate(rows, seed=s, n_splits=n_splits, n_repeats=1)
        out.append({"datasetSeed": s, **{m: cv["summary"][m]["prAuc"]["mean"] for m in MODELS}})
    wins = {b: sum(r["xgboost"] > r[b] for r in out) for b in MODELS if b != "xgboost"}
    return {"runs": out, "xgboostWins": wins, "of": len(out)}


def label_shuffle_control(rows: pd.DataFrame, seed: int, n_splits: int) -> dict:
    """Control negativo: con etiquetas barajadas el PR-AUC debe caer a la prevalencia (descarta fugas de datos)."""
    shuffled = rows.copy()
    shuffled["churn"] = np.random.default_rng(seed).permutation(shuffled.churn.to_numpy())
    cv = cross_validate(shuffled, seed=seed, n_splits=n_splits, n_repeats=1)
    return {"prevalence": float(rows.churn.mean()), "xgboostPrAuc": cv["summary"]["xgboost"]["prAuc"]["mean"]}


def shap_diagnostics(rows: pd.DataFrame, seeds=(1, 2, 3)) -> dict:
    """Cuantifica límites de SHAP: aditividad, estabilidad del ranking entre semillas y colinealidad."""
    x, y = rows[FEATURES], rows.churn
    importances, additivity = [], []
    for s in seeds:
        model = build_model(s, n_jobs=1).fit(x, y)
        explanation = shap.TreeExplainer(model)(x)
        logit = model.predict(x, output_margin=True)
        additivity.append(float(np.abs(explanation.values.sum(axis=1) + explanation.base_values - logit).max()))
        importances.append(np.abs(explanation.values).mean(axis=0))
    rank_corr = [float(spearmanr(importances[0], importances[i]).statistic) for i in range(1, len(seeds))]
    return {
        "maxAdditivityError": max(additivity),
        "meanAbsShapBySeed": {str(s): dict(zip(FEATURES, map(float, imp))) for s, imp in zip(seeds, importances)},
        "rankCorrelationVsFirstSeed": rank_corr,
        "featureCorrelation": rows[FEATURES].corr(method="spearman").round(4).to_dict(),
    }


def performance(rows: pd.DataFrame) -> dict:
    """Tiempos de referencia en esta máquina (no forman parte del hash reproducible)."""
    x, y = rows[FEATURES], rows.churn
    fits = []
    for _ in range(3):
        t = time.perf_counter()
        model = build_model(42, n_jobs=1).fit(x, y)
        fits.append(time.perf_counter() - t)
    batch = pd.concat([x] * (1000 // len(x) + 1)).iloc[:1000]
    t = time.perf_counter()
    model.predict_proba(batch)
    predict_ms = (time.perf_counter() - t) * 1000
    t = time.perf_counter()
    shap.TreeExplainer(model)(batch)
    shap_ms = (time.perf_counter() - t) * 1000
    return {"fitSecondsMedian": float(np.median(fits)), "predict1000Ms": predict_ms, "shap1000Ms": shap_ms, "trainingRows": int(len(rows))}


def run_benchmark(seed: int = DEFAULT_SEED, customers: int = SPEC["customers"], n_splits: int = 5, n_repeats: int = 3, stability_seeds=(11, 12, 13, 14, 15), with_performance: bool = True) -> dict:
    tx, as_of = make_churn_benchmark(seed=seed, customers=customers)
    rows, cutoff = build_training_rows(tx, as_of)
    results = {
        "dataset": {"seed": seed, "spec": {**SPEC, "customers": customers}, "transactions": len(tx), "trainingCustomers": int(len(rows)), "churnRate": float(rows.churn.mean()), "asOf": as_of, "cutoff": cutoff, "fingerprint": dataset_fingerprint(tx)},
        "features": FEATURES,
        "crossValidation": cross_validate(rows, seed, n_splits, n_repeats),
        "seedStability": seed_stability(rows),
        "datasetStability": dataset_stability(stability_seeds, n_splits),
        "labelShuffleControl": label_shuffle_control(rows, seed, n_splits),
        "shap": shap_diagnostics(rows),
    }
    results = _round(results)
    digest = hashlib.sha256(json.dumps(results, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    report = {"reproducibilityHash": digest, "results": results}
    report["environment"] = {"python": platform.python_version(), "xgboost": xgboost.__version__, "sklearn": sklearn.__version__, "shap": shap.__version__, "numpy": np.__version__, "pandas": pd.__version__}
    if with_performance:
        report["performance"] = _round(performance(rows), 4)
    return report


def to_markdown(report: dict) -> str:
    r = report["results"]
    cv = r["crossValidation"]
    lines = [f"Hash reproducible: `{report['reproducibilityHash']}`", "", f"Datos: {r['dataset']['trainingCustomers']} clientes, abandono {r['dataset']['churnRate']:.1%}, huella `{r['dataset']['fingerprint'][:16]}…`. Validación: {cv['folds']}.", "", "| Modelo | PR-AUC (media ± DE) | ROC-AUC | F1 @0.5 | Brier | Lift decil superior |", "|---|---|---|---|---|---|"]
    for m in MODELS:
        s = cv["summary"][m]
        lines.append(f"| {m} | {s['prAuc']['mean']:.3f} ± {s['prAuc']['std']:.3f} | {s['rocAuc']['mean']:.3f} | {s['f1']['mean']:.3f} | {s['brier']['mean']:.3f} | {cv['topDecileLift'][m]:.2f} |")
    lines += ["", "| Comparación (PR-AUC) | Diferencia media | IC 95 % | ¿Excluye 0? |", "|---|---|---|---|"]
    for k, c in cv["comparisons"].items():
        lines.append(f"| {k} | {c['meanDiff']:+.3f} | [{c['ci95'][0]:+.3f}, {c['ci95'][1]:+.3f}] | {'sí' if c['excludesZero'] else 'no'} |")
    ds = r["datasetStability"]
    lines += ["", f"Estabilidad entre semillas del modelo: PR-AUC {r['seedStability']['prAuc']['mean']:.3f} ± {r['seedStability']['prAuc']['std']:.4f}. Estabilidad entre muestras sintéticas: xgboost supera a {', '.join(f'{k} {v}/{ds['of']}' for k, v in ds['xgboostWins'].items())}.", f"Control con etiquetas barajadas: PR-AUC {r['labelShuffleControl']['xgboostPrAuc']:.3f} (prevalencia {r['labelShuffleControl']['prevalence']:.3f})."]
    if "performance" in report:
        p = report["performance"]
        lines.append(f"Rendimiento (referencia local): entrenamiento {p['fitSecondsMedian']:.2f} s, predicción de 1000 filas {p['predict1000Ms']:.1f} ms, SHAP de 1000 filas {p['shap1000Ms']:.0f} ms.")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="reports/ml_evaluation.json")
    parser.add_argument("--markdown")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()
    result = run_benchmark(seed=args.seed)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf8")
    if args.markdown:
        Path(args.markdown).write_text(to_markdown(result), encoding="utf8")
    print(to_markdown(result))
