import os

os.environ.setdefault("ML_SERVICE_TOKEN", "test-token-" + "x" * 40)

import numpy as np
import pytest

from datasets import dataset_fingerprint, make_churn_benchmark
from evaluation import MODELS, run_benchmark
from metrics import calibration_bins, classification_metrics, paired_bootstrap_diff, top_decile_lift

SMALL = dict(customers=420, n_splits=4, n_repeats=1, stability_seeds=(1, 2), with_performance=False)


@pytest.fixture(scope="module")
def report():
    return run_benchmark(**SMALL)


def test_metrics_known_values():
    y = np.array([1, 1, 0, 0])
    m = classification_metrics(y, np.array([0.9, 0.4, 0.6, 0.1]))
    assert m["confusion"] == {"tp": 1, "fp": 1, "fn": 1, "tn": 1}
    assert m["precision"] == 0.5 and m["recall"] == 0.5
    assert top_decile_lift(np.array([1] + [0] * 9), np.linspace(1, 0, 10)) == pytest.approx(10.0)
    assert sum(b["n"] for b in calibration_bins(y, np.array([0.9, 0.4, 0.6, 0.1]))) == 4


def test_bootstrap_detects_real_difference():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 400)
    good = y * 0.6 + rng.random(400) * 0.4
    noise = rng.random(400)
    from sklearn.metrics import average_precision_score

    assert paired_bootstrap_diff(y, good, noise, average_precision_score, n=100)["excludesZero"]


def test_dataset_is_deterministic_and_fingerprinted():
    a, _ = make_churn_benchmark(seed=7, customers=60)
    b, _ = make_churn_benchmark(seed=7, customers=60)
    c, _ = make_churn_benchmark(seed=8, customers=60)
    assert dataset_fingerprint(a) == dataset_fingerprint(b) != dataset_fingerprint(c)


def test_results_are_reproducible(report):
    again = run_benchmark(**SMALL)
    assert again["reproducibilityHash"] == report["reproducibilityHash"]
    assert again["results"] == report["results"]


def test_compares_against_all_baselines(report):
    cv = report["results"]["crossValidation"]
    assert set(cv["summary"]) == set(MODELS)
    # Frente a la línea base trivial (prior) la ventaja debe ser clara y estadísticamente distinguible.
    assert cv["comparisons"]["xgboost_vs_baseline_prior"]["excludesZero"]
    assert cv["summary"]["xgboost"]["prAuc"]["mean"] > cv["summary"]["baseline_prior"]["prAuc"]["mean"] + 0.2
    # Mide errores y estabilidad, no solo una métrica.
    assert {"tp", "fp", "fn", "tn"} == set(cv["errorsAtThreshold0.5"]["xgboost"])
    assert cv["summary"]["xgboost"]["prAuc"]["std"] >= 0
    assert report["results"]["datasetStability"]["of"] == 2


def test_no_label_leakage_control(report):
    control = report["results"]["labelShuffleControl"]
    assert abs(control["xgboostPrAuc"] - control["prevalence"]) < 0.1


def test_shap_diagnostics(report):
    shap_info = report["results"]["shap"]
    assert shap_info["maxAdditivityError"] < 1e-3
    assert len(shap_info["rankCorrelationVsFirstSeed"]) == 2
