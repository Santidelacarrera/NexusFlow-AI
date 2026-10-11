FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ORCHESTRATOR_DB=/data/orchestrator.db
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 orch && mkdir /data && chown orch /data
WORKDIR /app
COPY services/orchestrator/requirements.txt ./requirements.txt
COPY services/orchestrator/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.txt -c requirements.lock
COPY --chown=orch:orch services/orchestrator/nexusflow_engine ./nexusflow_engine
USER orch
VOLUME /data
EXPOSE 8002
# Un solo worker: el motor conduce cada run desde un único proceso (ver docs/ORCHESTRATOR.md, «Límites»).
CMD ["uvicorn", "nexusflow_engine.main:app", "--host", "0.0.0.0", "--port", "8002", "--no-access-log", "--limit-concurrency", "100"]
