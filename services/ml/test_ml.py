import os
os.environ.setdefault("ML_SERVICE_TOKEN", "test-token-" + "x" * 40)

from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient
from features import build_training_rows
import model
from main import app


def fixture_transactions():
    end = datetime(2026, 10, 1, tzinfo=timezone.utc)
    transactions = []
    for i in range(120):
        # Ambos grupos tienen historial; el retenido compra también en la ventana de etiqueta.
        offsets = [230, 200, 180] if i < 60 else [230, 130, 100, 20]
        for days in offsets:
            transactions.append({"customerId": f"c{i}", "amount": 50 + i, "occurredAt": (end - timedelta(days=days)).isoformat()})
    return transactions, end.isoformat()


def test_features_do_not_include_label_window():
    tx, end = fixture_transactions()
    rows, _ = build_training_rows(tx, end)
    retained = rows[rows.customerId == "c100"].iloc[0]
    assert retained.frequency == 3
    assert retained.recencyDays == 10
    assert retained.churn == 0
    assert rows[rows.customerId == "c1"].iloc[0].churn == 1


def test_auth_and_validation():
    with TestClient(app) as client:
        assert client.post("/score", json={}).status_code == 401
        assert client.post("/score", headers={"Authorization": "Bearer " + os.environ["ML_SERVICE_TOKEN"]}, json={"orgId": "o", "customers": [{"customerId": "c", "recencyDays": -1, "frequency": 2, "monetary": 10}]}).status_code == 422


def test_train_score_and_organization_isolation(tmp_path, monkeypatch):
    monkeypatch.setattr(model, "MODEL_ROOT", tmp_path)
    tx, end = fixture_transactions()
    result = model.train("org-a", tx, end)
    assert result["promoted"] is True
    assert result["metrics"]["prAuc"] > result["metrics"]["baseline"]["prAuc"]
    customers = [{"customerId": "c1", "recencyDays": 90, "frequency": 3, "monetary": 100}]
    scored = model.score("org-a", customers)
    assert scored["mode"] == "trained"
    assert scored["predictions"][0]["explanation"]["method"] == "SHAP"
    assert model.score("org-b", customers)["mode"] == "heuristic"
