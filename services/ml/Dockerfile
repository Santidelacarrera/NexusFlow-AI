FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODEL_DIR=/app/models
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 ml
WORKDIR /app
COPY services/ml/requirements.txt ./requirements.txt
COPY services/ml/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.txt -c requirements.lock
COPY --chown=ml:ml services/ml/*.py ./
RUN mkdir models && chown ml:ml models
USER ml
EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--no-access-log", "--limit-concurrency", "20"]
