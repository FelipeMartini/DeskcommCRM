#!/usr/bin/env bash
# ==============================================================================
# PLANO B LOCAL: Construir imagens no Docker do WSL (Notebook) e enviar para 10.1.1.4
# ==============================================================================
# Uso:
#   bash scripts/construir-local.sh              # Apenas constrói localmente
#   bash scripts/construir-local.sh --enviar     # Constrói e carrega no Docker de 10.1.1.4
# ==============================================================================
set -euo pipefail

SERVIDOR="${DEPLOY_HOST:-root@10.1.1.4}"
TAG_APP="expanda-crm:latest"
TAG_WORKER="expanda-crm-worker:latest"
ENVIAR=0

for arg in "$@"; do
  case "$arg" in
    --enviar) ENVIAR=1 ;;
    *) echo "Argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

titulo() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()     { printf '   \033[32mok\033[0m  %s\n' "$1"; }
erro()   { printf '   \033[31mERRO\033[0m %s\n' "$1" >&2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

titulo "1/3 Verificando Docker local"
docker info >/dev/null 2>&1 || {
  erro "O daemon Docker não está rodando no ambiente local/WSL."
  exit 1
}
ok "Docker local respondendo com sucesso"

titulo "2/3 Construindo imagens localmente no notebook"
echo "--- Compilando App Web Next.js ($TAG_APP) ---"
docker build -t "$TAG_APP" -f Dockerfile .
ok "Imagem $TAG_APP construída com sucesso"

echo "--- Compilando Worker ($TAG_WORKER) ---"
docker build -t "$TAG_WORKER" -f Dockerfile.worker .
ok "Imagem $TAG_WORKER construída com sucesso"

if [ "$ENVIAR" = "1" ]; then
  titulo "3/3 Enviando imagens para o servidor $SERVIDOR via SSH"
  echo "Salvando, compactando e transmitindo imagens para $SERVIDOR..."
  docker save "$TAG_APP" "$TAG_WORKER" | gzip -1 | ssh -o BatchMode=yes -o ConnectTimeout=30 "$SERVIDOR" "gunzip | docker load"
  ok "Imagens carregadas com sucesso no daemon Docker de $SERVIDOR!"
else
  titulo "3/3 Concluído localmente"
  ok "Imagens prontas no Docker local. Use --enviar para transferir para $SERVIDOR."
fi
