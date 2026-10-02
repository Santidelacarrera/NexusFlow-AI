"""Features calculadas antes del corte; etiquetas únicamente en la ventana posterior."""
import pandas as pd

FEATURES = ["recencyDays", "frequency", "monetary"]


def build_training_rows(transactions: list[dict], as_of: str, horizon_days: int = 90):
    frame = pd.DataFrame(transactions)
    if frame.empty:
        raise ValueError("No hay transacciones")
    frame["occurredAt"] = pd.to_datetime(frame["occurredAt"], utc=True)
    end = pd.Timestamp(as_of)
    if end.tzinfo is None:
        end = end.tz_localize("UTC")
    else:
        end = end.tz_convert("UTC")
    cutoff = end - pd.Timedelta(days=horizon_days)
    history = frame[frame.occurredAt <= cutoff]
    if history.empty or (cutoff - history.occurredAt.min()).days < 90:
        raise ValueError("Se requieren al menos 180 días de historial observado")
    agg = history.groupby("customerId").agg(last=("occurredAt", "max"), frequency=("amount", "size"), monetary=("amount", "sum"))
    agg["recencyDays"] = (cutoff - agg["last"]).dt.total_seconds() / 86400
    future_buyers = set(frame[(frame.occurredAt > cutoff) & (frame.occurredAt <= end)].customerId)
    agg["churn"] = [int(cid not in future_buyers) for cid in agg.index]
    return agg.reset_index()[["customerId", *FEATURES, "churn"]], cutoff.isoformat()
