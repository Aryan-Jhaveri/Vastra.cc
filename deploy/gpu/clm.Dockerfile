# clm-serve: CLM-v0.1-8B behind the TypeSafe /v1/systemone API (#351 / #354).
# CPU-light API process; the GPU work happens in the separate `clm-embed`
# service (vLLM Qwen3-8B, pooling runner) that it calls for embeddings.
FROM python:3.12-slim

# A github.com/Contrastive-LM/CLM commit or tag. Pin it.
ARG CLM_REF=main

ENV PIP_NO_CACHE_DIR=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/Contrastive-LM/CLM.git /opt/clm \
 && cd /opt/clm && git fetch origin "${CLM_REF}" && git checkout FETCH_HEAD \
 && pip install -e .

EXPOSE 8700
ENTRYPOINT ["clm-serve"]
