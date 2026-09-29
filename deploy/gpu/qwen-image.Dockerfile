# Qwen-Image-2.1 on vLLM-Omni (#352 / #354). Follows the vLLM recipe
# (recipes.vllm.ai/Qwen/Qwen-Image-2.1): vLLM + vLLM-Omni installed from
# source, because Qwen-Image-2.1 support lands on a vLLM-Omni branch before a
# release. Pin both refs once #296 Phase 0 has run the stack on real hardware.
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-devel-ubuntu24.04
FROM ${CUDA_IMAGE}

ARG VLLM_VERSION=0.30.0
# Qwen-Image-2.1 support is vLLM-Omni PR #8099 (rebased on vLLM 0.30.0); verified
# on an RTX A6000 2026-09-27 at commit cc0defc44. The recipe's vLLM 0.29.0 fails
# with this branch (IrOpPriorityConfig). Switch to a release once #8099 merges.
ARG VLLM_OMNI_REF=refs/pull/8099/head

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-venv python3-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --upgrade pip && pip install "vllm==${VLLM_VERSION}"
RUN git clone https://github.com/vllm-project/vllm-omni.git /opt/vllm-omni \
 && cd /opt/vllm-omni && git fetch origin "${VLLM_OMNI_REF}" && git checkout FETCH_HEAD \
 && pip install -e .

EXPOSE 8091
ENTRYPOINT ["vllm", "serve"]
